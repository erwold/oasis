/** Test-only SSH stdin source transformer. OpenSSH, adapter, detached supervisor and child
 * are real; only selected Python storage syscalls raise deterministic ENOSPC.
 * No production fault-injection hooks or fake Popen are used by these acceptance tests. */
import { streamingPythonWrapper } from './python_wrapper.fixture.ts'
export function storageFaultPython(dir: string, mode: 'running' | 'log' | 'terminal'): string {
  const injection = `
if 'registry_path' in globals():
    def registry_path(): return ${JSON.stringify(dir+'/registry')}
if len(sys.argv)>1 and sys.argv[1]=='--supervisor':
    import errno
    _real_atomic, _real_open, _real_fsync = atomic, open, os.fsync
    _fault_mode = ${JSON.stringify(mode)}
    _fault_count = 0
    _log_fds = set()
    def atomic(path, value):
        global _fault_count
        if os.path.basename(path)=='running.json':
            _real_atomic(os.path.join(os.path.dirname(path),'fault-identity.json'), value)
            if _fault_mode=='running' and _fault_count==0:
                _fault_count += 1
                raise OSError(errno.ENOSPC, 'test running receipt storage fault')
        if _fault_mode=='terminal' and os.path.basename(path) in ('exit.json','storage-failed.json') and _fault_count<3:
            _fault_count += 1
            raise OSError(errno.ENOSPC, 'test terminal storage temporarily full')
        return _real_atomic(path,value)
    def open(path, *args, **kwargs):
        f=_real_open(path,*args,**kwargs)
        if os.path.basename(str(path)) in ('stdout','stderr'):
            _log_fds.add(f.fileno())
        return f
    def _fault_fsync(fd):
        global _fault_count
        if _fault_mode=='log' and fd in _log_fds and _fault_count==0:
            _fault_count += 1
            raise OSError(errno.ENOSPC, 'test log fsync storage fault')
        return _real_fsync(fd)
    os.fsync=_fault_fsync
`
  return streamingPythonWrapper(dir+'/python-fault-'+mode, injection, dir+'/adapter-pids.log')
}
