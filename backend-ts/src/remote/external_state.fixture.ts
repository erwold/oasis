import { randomUUID } from 'node:crypto'
import { streamingPythonWrapper } from './python_wrapper.fixture.ts'
/** Real SSH adapter/supervisor, with only shared-volume chmod/mkdir semantics emulated.
 * A fixture-private registry substitutes for the fixed per-user /tmp registry; it is NOT
 * a production constructor/wire option that could split leases between SSH aliases. */
export function externalStatePython(dir:string, shared:string, baseline?:string, extraInjection=''):string {
  const injection=`
_real_mkdir, _real_chmod = os.mkdir, os.chmod
_shared = ${JSON.stringify(shared)}
def _is_shared(path):
    return isinstance(path, str) and (os.path.realpath(path)==_shared or os.path.realpath(path).startswith(_shared+'/'))
def _shared_mkdir(path, mode=0o777, *, dir_fd=None):
    result=_real_mkdir(path, mode, dir_fd=dir_fd)
    if dir_fd is None and _is_shared(path): _real_chmod(path, 0o777)
    return result
def _shared_chmod(path, mode, **kwargs):
    return _real_chmod(path, 0o777 if _is_shared(path) else mode, **kwargs)
os.mkdir, os.chmod = _shared_mkdir, _shared_chmod
if 'registry_path' in globals():
    def registry_path(): return ${JSON.stringify(dir+'/registry')}
${extraInjection}
`
  return streamingPythonWrapper(dir+'/external-python-'+randomUUID(), injection, dir+'/adapter-pids.log', baseline ?? '')
}
