# source this with QA_ROOT set to a scratch folder of your own (never your HOME): every HOME, TMPDIR, XDG, data,
# cache and log of the fixture runs goes under it. usage: QA_ROOT=/path/to/scratch . tests/full_access_mac/env.sh
: "${QA_ROOT:?set QA_ROOT to a scratch folder of your own}"
mkdir -p "$QA_ROOT" && QA_ROOT=$(cd "$QA_ROOT" && pwd -P)
export QA_ROOT
export QA_DIR=${QA_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)}
mkdir -p "$QA_ROOT/env/home" "$QA_ROOT/env/tmp" "$QA_ROOT/fixtures" "$QA_ROOT/logs" "$QA_ROOT/s"
export HOME=$QA_ROOT/env/home TMPDIR=$QA_ROOT/env/tmp
export XDG_CONFIG_HOME=$QA_ROOT/env/xdg/config XDG_CACHE_HOME=$QA_ROOT/env/xdg/cache XDG_DATA_HOME=$QA_ROOT/env/xdg/data XDG_STATE_HOME=$QA_ROOT/env/xdg/state
export OASIS_CODE_DATA=$QA_ROOT/env/data OASIS_CODE_USER_DATA=$QA_ROOT/env/userdata
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/false SSH_ASKPASS=/usr/bin/false
unset SSH_AUTH_SOCK GIT_SSH GIT_SSH_COMMAND
export npm_config_cache=$QA_ROOT/env/cache/npm npm_config_userconfig=$QA_ROOT/env/home/.npmrc
export BUN_INSTALL_CACHE_DIR=$QA_ROOT/env/cache/bun
export SHELL=/bin/zsh
