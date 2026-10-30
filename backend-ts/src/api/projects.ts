import type { Project } from '@oasis-code/contract'
import { Hono } from 'hono'
import { CheckConfigSchema, ImportBodySchema, ProjectConfigBodySchema, type CheckConfig, NO_FOLDER_PROJECT } from '@oasis-code/contract'
import * as repo from '../db/repo.ts'
import { GitError } from '../workspace/git.ts'
import { SnapshotTooLarge } from '../workspace/measure.ts'
import { makeProjectFolder, RootRefused } from '../workspace/roots.ts'
import { agentBound, HttpError, parseBody, type Api } from './common.ts'
import { requireProject } from './state.ts'

/** Imports under way by their client key (this process): a second request with the key waits for the first. */
const importing = new Map<string, Promise<Project>>()
/** The no-folder project while it is being made (the first task without a folder makes it). */
let noFolder: Promise<Project> | null = null

export function projectRoutes(api: Api): Hono {
  const app = new Hono()
  const { state } = api

  app.get('/api/projects', (c) => c.json(repo.listProjects(state.conn).map((p) => ({ ...p, sessions: repo.listSessions(state.conn, p.id) }))))

  app.post('/api/projects', async (c) => {
    const body = await parseBody(c, ImportBodySchema)
    // an agent run's request (open_ssh_session) opens a folder on an SSH host, held to that run's bounds — nothing else
    if (agentBound(state) !== null && body.target?.kind !== 'ssh') throw new HttpError(403, 'an agent run opens only a folder on an SSH host; other projects are the person\'s, in oasis-code', 'agent_route')
    if (body.target?.kind === 'ssh') {
      state.remote.target(body.target.target_id) // validate BEFORE any local path operation or idempotency reuse
      if (body.mode !== 'direct' || !body.source_path || body.no_folder || body.create_directory) throw new HttpError(400, 'SSH workspaces require an existing folder and direct mode.', 'capability_unavailable')
      const targetId = body.target.target_id
      const key = body.client_request_id ?? null
      const previous = key ? repo.projectForClientRequest(state.conn, key) : null
      if (previous) {
        if (previous.target?.kind !== 'ssh' || previous.target.target_id !== targetId || previous.import_report.requested_path !== body.source_path || previous.import_report.requested_state_path !== (body.remote_state_path ?? null)) throw new HttpError(409, 'The request key belongs to another project identity.', 'version_conflict')
        return c.json(previous)
      }
      const importKey = key ? `ssh:${key}` : null
      const creating = importKey ? importing.get(importKey) : null
      if (creating) {
        const made = await creating
        if (made.target?.kind !== 'ssh' || made.target.target_id !== targetId || made.import_report.requested_path !== body.source_path || made.import_report.requested_state_path !== (body.remote_state_path ?? null)) throw new HttpError(409, 'The request key belongs to another project identity.', 'version_conflict')
        return c.json(made)
      }
      const create = async () => {
        const root = await state.remote.openRoot(targetId, body.source_path!, body.remote_state_path)
        return state.conn.transaction(() => {
          const p = repo.createProject(state.conn, body.name || root.path.split('/').pop() || root.path, { kind: 'direct', source_path: root.path, base_repo_path: '', base_commit: null, base_branch: null, remote: root, default_model: body.default_model,
            import_report: { kind: 'direct', files_carried: 0, requested_path: body.source_path, requested_state_path: body.remote_state_path ?? null, basis: 'Remote folder edited in place. Only file-tool writes are journalled; command writes are not snapshots.' }, config: body.instructions ? { instructions: body.instructions } : {} })
          if (key) repo.setProjectClientRequest(state.conn, p.id, key)
          return p
        })
      }
      const pending = create()
      if (importKey) importing.set(importKey, pending)
      try { return c.json(await pending) } finally { if (importKey) importing.delete(importKey) }
    }
    if (body.remote_state_path !== undefined) throw new HttpError(400, 'remote_state_path requires an SSH target', 'target_required')
    // a task that needs no folder: the one project for them, made once (two starts at once make it once)
    if (body.no_folder) {
      const found = repo.listProjects(state.conn).find((p) => p.config.no_folder === true)
      if (found) return c.json(found)
      noFolder ??= (async () => {
        const made = await state.workspaces.createEmptyProject(NO_FOLDER_PROJECT, { default_model: body.default_model ?? null })
        repo.updateProject(state.conn, made.id, { config: { ...made.config, no_folder: true } })
        return repo.getProject(state.conn, made.id)!
      })().finally(() => { noFolder = null })
      return c.json(await noFolder)
    }
    // the start screen's key: a request sent again answers with the project it made, or joins the import under way
    // (a big folder takes a while, and a second copy of it is what the key is for)
    const key = body.client_request_id ?? null
    const made = key !== null ? repo.projectForClientRequest(state.conn, key) : null
    if (made?.target?.kind === 'ssh') throw new HttpError(409, 'The request key belongs to an SSH target, not a local project.', 'version_conflict')
    if (made !== null) return c.json(made)
    if (body.worktree) {
      const also = [body.no_folder ? 'no_folder' : '', body.create_directory ? 'create_directory' : '', body.mode && body.mode !== 'direct' ? `mode ${body.mode}` : ''].filter(Boolean)
      if (!body.source_path) throw new HttpError(400, 'worktree names the repository by source_path', 'path_required', { next_step: 'give source_path, a folder of the repository' })
      if (also.length) throw new HttpError(400, `worktree is not combined with ${also.join(', ')}: a worktree opens in direct mode`, 'invalid_input')
    }
    if (body.create_directory && !body.source_path) throw new HttpError(400, 'create_directory names the folder to make by source_path', 'path_required', { next_step: 'give source_path, the folder to make' })
    let directoryCreated = false
    const create = async () => {
      let created
      if (body.source_path) {
        const name = body.name || body.source_path.replace(/\/+$/, '').split('/').pop() || body.source_path
        // the folder made first, when asked: its last component only, in a parent that exists (nothing else is made)
        let source = body.source_path
        if (body.create_directory) {
          try {
            const made = makeProjectFolder(body.source_path, [state.settings.data_dir, state.settings.workspaces_dir])
            source = made.path
            directoryCreated = made.created
          } catch (error) {
            if (error instanceof RootRefused) throw new HttpError(400, `${error.message}; ${error.next_step}`, error.code, { next_step: error.next_step })
            throw error
          }
        }
        if (body.worktree) {
          try {
            created = await state.workspaces.worktreeProject(body.name ?? null, source, body.worktree, { default_model: body.default_model ?? null })
          } catch (error) {
            if (error instanceof RootRefused) throw new HttpError(400, `${error.message}; ${error.next_step}`, error.code, { next_step: error.next_step })
            throw error
          }
        } else created = await state.workspaces.importProject(name, source, { default_model: body.default_model ?? null, mode: body.mode ?? null })
      } else {
        if (!body.name) throw new HttpError(400, 'a new project needs a name')
        created = await state.workspaces.createEmptyProject(body.name, { default_model: body.default_model ?? null })
      }
      if (key !== null) repo.setProjectClientRequest(state.conn, created.id, key)
      return created
    }
    let project
    try {
      const underway = key !== null ? importing.get(key) : undefined
      if (underway) project = await underway
      else {
        const work = create()
        if (key !== null) importing.set(key, work)
        try { project = await work } finally { if (key !== null) importing.delete(key) }
      }
    } catch (error) {
      if (error instanceof SnapshotTooLarge) return c.json(error.asBody(), 413)
      if (error instanceof GitError) throw new HttpError(400, error.message)
      throw error
    }
    if (body.instructions) {
      repo.updateProject(state.conn, project.id, { config: { ...project.config, instructions: body.instructions } })
      project = repo.getProject(state.conn, project.id)!
    }
    return c.json(body.create_directory ? { ...project, directory_created: directoryCreated } : project)
  })

  app.get('/api/projects/:project_id', (c) => {
    const project = requireProject(state, c.req.param('project_id'))
    return c.json({ ...project, sessions: repo.listSessions(state.conn, project.id), workspaces: repo.listWorkspaces(state.conn, project.id) })
  })

  app.put('/api/projects/:project_id/config', async (c) => {
    const projectId = c.req.param('project_id')
    const project = requireProject(state, projectId)
    const body = await parseBody(c, ProjectConfigBodySchema)
    const config: Record<string, unknown> = { ...project.config }
    if (body.instructions !== null && body.instructions !== undefined) config.instructions = body.instructions
    if (body.protected_paths !== null && body.protected_paths !== undefined) config.protected_paths = body.protected_paths
    if (body.checks !== null && body.checks !== undefined) {
      const checks = []
      for (const raw of body.checks) {
        const parsed = CheckConfigSchema.safeParse(raw)
        if (!parsed.success) throw new HttpError(422, `checks: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
        checks.push(parsed.data)
      }
      config.checks = checks
    }
    repo.updateProject(state.conn, projectId, { config, default_model: body.default_model ?? null })
    return c.json(repo.getProject(state.conn, projectId))
  })

  /** Additions to the configuration (a director's route): the checks and the protected paths the project has stay
   *  as they are — a check given under an id the project has must be that check — and the ones given besides are
   *  added; the instructions and the default model are set when given. Read, merged and written in one step,
   *  nothing awaited between, so two callers adding at once both land and neither's snapshot decides. */
  app.post('/api/projects/:project_id/config/additions', async (c) => {
    const projectId = c.req.param('project_id')
    const body = await parseBody(c, ProjectConfigBodySchema)
    const given: CheckConfig[] = []
    for (const raw of body.checks ?? []) {
      const parsed = CheckConfigSchema.safeParse(raw)
      if (!parsed.success) throw new HttpError(422, `checks: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
      given.push(parsed.data)
    }
    const project = requireProject(state, projectId)
    const config: Record<string, unknown> = { ...project.config }
    if (body.checks !== null && body.checks !== undefined) {
      const checks = ((project.config.checks as unknown[] | undefined) ?? []).map((c) => CheckConfigSchema.safeParse(c)).filter((r) => r.success).map((r) => r.data!)
      for (const check of given) {
        const same = checks.find((existing) => existing.id === check.id)
        if (same === undefined) checks.push(check)
        else if (JSON.stringify(same) !== JSON.stringify(check)) throw new HttpError(409, `check ${check.id} is the project's: it stays as it is; add a check under another id`)
      }
      config.checks = checks
    }
    if (body.protected_paths !== null && body.protected_paths !== undefined) {
      config.protected_paths = [...new Set([...((project.config.protected_paths as string[] | undefined) ?? []), ...body.protected_paths])]
    }
    if (body.instructions !== null && body.instructions !== undefined) config.instructions = body.instructions
    repo.updateProject(state.conn, projectId, { config, default_model: body.default_model ?? null })
    return c.json(repo.getProject(state.conn, projectId))
  })

  return app
}
