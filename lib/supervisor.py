"""Start the GPT-SoVITS API and tie its lifetime to the DSH process.

Run with ``pythonw.exe`` so no console is ever created.

Two jobs, and they are the same job:

1. **Start the engine without flicker.** The previous launcher was a batch file
   whose readiness wait was ``ping -n 4 127.0.0.1 >nul`` -- and ``ping.exe`` is a
   console program, so a cold start flashed 30-45 console windows. Here the wait
   is a plain socket connect, and the engine is spawned through ``pythonw.exe``,
   so nothing produces a window at all.
2. **Stop the engine when DSH stops.** The engine used to be deliberately
   detached so it would outlive DSH; now the opposite is wanted. The supervisor
   polls the DSH process and terminates the engine it started as soon as DSH is
   gone -- including when DSH is force-killed, which no in-process shutdown hook
   can cover.

Deliberately conservative: an engine the supervisor did **not** start is never
killed, because it may be one the user started by hand.
"""

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

# Windows: do not create a console window for the child.
CREATE_NO_WINDOW = 0x08000000

# Readiness polling. Model load takes 12-60s, so allow generous headroom.
POLL_SECONDS = 0.7
POLL_TRIES = 200

# How often to check whether DSH is still alive.
WATCH_SECONDS = 2.0


def log(path, message):
    """Append one timestamped line, never raising."""
    line = '[%s] %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), message)
    try:
        with open(path, 'a', encoding='utf-8', errors='replace') as handle:
            handle.write(line)
    except OSError:
        pass


def port_open(host, port):
    """True when something accepts a TCP connection on host:port."""
    try:
        with socket.create_connection((host, port), timeout=1.0):
            return True
    except OSError:
        return False


def local_opener():
    """
    A URL opener that never uses a proxy.

    Measured on the development machine: `urllib` picks up a system proxy from
    the Windows registry (a local proxy answered on `127.0.0.1:26561`), so
    `urlopen('http://127.0.0.1:9880/control')` was answered **by the proxy**, not
    by the engine -- it returned 404 while nothing at all was listening on 9880.
    A liveness check for a loopback service must bypass proxies entirely, or it
    reports a live engine that does not exist and the supervisor adopts a port
    nobody is serving.
    """
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


# Built once: no proxies, ever.
LOCAL_OPENER = local_opener()


def api_answers(base):
    """
    True when the engine itself is up.

    ``GET /control`` without a ``command`` answers HTTP 400 by design, so a 400
    proves the API is running, and a 200 proves it too.

    Anything else -- including a refused connection -- is **not** ready. Only a
    4xx or 5xx *response from the engine* counts; the first version accepted "any
    HTTP error", which both let a refused connection look like a live engine and
    let a proxy's 404 stand in for one.
    """
    try:
        with LOCAL_OPENER.open(base + '/control', timeout=2.0) as response:
            return 200 <= response.status < 300
    except urllib.error.HTTPError as error:
        # The engine answered. 400 is the documented no-command reply.
        return 400 <= error.code < 600
    except Exception:
        # Connection refused, timeout, proxy refused: nothing is serving.
        return False


def pids_on_port(port):
    """
    PIDs listening on a local TCP port.

    Uses the Win32 IP Helper API through ``ctypes`` rather than shelling out to
    ``netstat``: it needs no extra process (nothing to flicker), it cannot be
    defeated by console-code-page parsing, and it is exact. `netstat` was tried
    first and returned an empty set for a live listener, which silently broke
    adoption.
    """
    if os.name != 'nt':
        return set()
    import ctypes

    AF_INET = 2
    TCP_TABLE_OWNER_PID_LISTENER = 3

    class MIB_TCPROW_OWNER_PID(ctypes.Structure):
        _fields_ = [
            ('dwState', ctypes.c_ulong),
            ('dwLocalAddr', ctypes.c_ulong),
            ('dwLocalPort', ctypes.c_ulong),
            ('dwRemoteAddr', ctypes.c_ulong),
            ('dwRemotePort', ctypes.c_ulong),
            ('dwOwningPid', ctypes.c_ulong),
        ]

    size = ctypes.c_ulong(0)
    try:
        ctypes.windll.iphlpapi.GetExtendedTcpTable(
            None, ctypes.byref(size), False, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0)
        if size.value == 0:
            return set()
        buffer = ctypes.create_string_buffer(size.value)
        result = ctypes.windll.iphlpapi.GetExtendedTcpTable(
            buffer, ctypes.byref(size), False, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0)
        if result != 0:
            return set()
    except Exception:
        return set()

    count = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ulong)).contents.value
    row_size = ctypes.sizeof(MIB_TCPROW_OWNER_PID)
    rows = ctypes.cast(
        ctypes.byref(buffer, ctypes.sizeof(ctypes.c_ulong)),
        ctypes.POINTER(MIB_TCPROW_OWNER_PID),
    )
    pids = set()
    for index in range(count):
        row = rows[index]
        # dwLocalPort holds the port in network byte order in the low 16 bits.
        local_port = ((row.dwLocalPort & 0xFF) << 8) | ((row.dwLocalPort >> 8) & 0xFF)
        if local_port == port and row.dwOwningPid > 0:
            pids.add(int(row.dwOwningPid))
    del row_size
    return pids


def process_alive(pid):
    """
    True when a process with that pid exists.

    Uses ``OpenProcess`` through ``ctypes``. The first version shelled out to
    ``tasklist`` and matched its text output, which misreported a live process as
    dead -- the supervisor then decided its parent was already gone and exited
    immediately after starting the engine, leaving the engine unmanaged and
    running forever. A process check this load-bearing must not be text parsing.
    """
    if pid <= 0:
        return False
    if os.name != 'nt':
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    import ctypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        # Access denied still proves the process exists; a genuinely missing pid
        # fails with ERROR_INVALID_PARAMETER (87).
        return kernel32.GetLastError() == 5
    try:
        code = ctypes.c_ulong(0)
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return True
        return code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def kill_tree(pid):
    """Force-kill a process and its children."""
    try:
        subprocess.run(
            ['taskkill', '/PID', str(pid), '/T', '/F'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=CREATE_NO_WINDOW, timeout=20,
        )
    except Exception:
        pass


def write_pid_file(path, data):
    try:
        with open(path, 'w', encoding='utf-8') as handle:
            json.dump(data, handle, indent=2)
    except OSError:
        pass


def read_pid_file(path):
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def stop_existing(state_dir, log_path):
    """
    Stop a supervisor from an earlier run and the engine it owns.

    Used when the plugin unloads while DSH keeps running, and to clean up after
    a crash. An engine the supervisor did not start is left alone by design.
    """
    record = read_pid_file(os.path.join(state_dir, 'engine.pid'))
    supervisor_pid = int(record.get('supervisor_pid') or 0)
    api_pid = int(record.get('api_pid') or 0)
    owned = bool(record.get('owned'))

    log(log_path, 'stop requested: supervisor=%d api=%d owned=%s' % (supervisor_pid, api_pid, owned))

    if supervisor_pid and process_alive(supervisor_pid):
        kill_tree(supervisor_pid)
    if owned and api_pid and process_alive(api_pid):
        kill_tree(api_pid)

    for _ in range(15):
        if not (api_pid and process_alive(api_pid)):
            break
        time.sleep(0.4)

    try:
        pid_file = os.path.join(state_dir, 'engine.pid')
        if os.path.exists(pid_file):
            os.remove(pid_file)
    except OSError:
        pass
    log(log_path, 'stop done: api_alive=%s' % (bool(api_pid) and process_alive(api_pid)))
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stop', action='store_true', help='stop a supervisor from an earlier run')
    parser.add_argument('--adopt-pid', type=int, default=0, help='DSH process this engine belongs to')
    parser.add_argument('--server', default='', help='engine base URL, e.g. http://127.0.0.1:9880')
    parser.add_argument('--engine-root', default='')
    parser.add_argument('--api', default='', help='api_v2.py path')
    parser.add_argument('--yaml', default='', help='tts_infer.yaml path')
    parser.add_argument('--python', default='', help='python.exe path used to run api_v2.py')
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--log', required=True)
    parser.add_argument(
        '--engine-log', default='',
        help='capture the engine stdout/stderr here; empty discards them',
    )
    options = parser.parse_args()

    if options.stop:
        return stop_existing(options.state_dir, options.log)

    missing = [name for name in ('server', 'engine_root', 'api', 'python') if not getattr(options, name)]
    if missing:
        log(options.log, 'ERROR missing required arguments: %s' % ', '.join(missing))
        return 2

    pid_file = os.path.join(options.state_dir, 'engine.pid')
    base = options.server.rstrip('/')
    try:
        port = int(base.rsplit(':', 1)[1])
    except (IndexError, ValueError):
        log(options.log, 'ERROR cannot parse a port from %r' % base)
        return 1

    log(options.log, 'supervisor start: port=%d dsh_pid=%d' % (port, options.adopt_pid))

    previous = read_pid_file(pid_file)
    started_pid = 0
    owned = False

    if api_answers(base):
        existing = sorted(pids_on_port(port))
        log(options.log, 'engine already answering; pid(s) %s' % (existing or 'unknown'))
        if len(existing) == 1:
            started_pid = existing[0]
            # Adopt only an engine we can still account for: the pid file names
            # this port and the DSH that owned it. Anything else may be the
            # user's own engine, and killing that on DSH exit would be wrong.
            same_port = previous.get('server', '') == base
            owned = same_port or bool(previous.get('owned'))
            log(options.log, 'adopting pid %d (owned=%s)' % (started_pid, owned))
        else:
            log(options.log, 'cannot adopt cleanly (%d listeners); leaving the engine alone' % len(existing))
    else:
        occupied = pids_on_port(port)
        if occupied:
            # Something holds the port but does not answer: a half-dead engine
            # from a previous run would block the new one forever.
            log(options.log, 'port %d held by %s but not answering; clearing it' % (port, sorted(occupied)))
            for pid in occupied:
                kill_tree(pid)
            time.sleep(1.0)

        command = [options.python, options.api, '-a', '127.0.0.1', '-p', str(port)]
        if options.yaml:
            command += ['-c', options.yaml]
        log(options.log, 'spawning: %s' % ' '.join(command))
        """
        Capture the engine's output instead of discarding it.

        This is what used to be visible in the API window, and losing it made every
        engine-side problem invisible: the log the user could read said only
        "ready=True", while the interesting lines (weight loading, the text being
        synthesized, tracebacks) went to DEVNULL. The plugin shows this file in its
        side panel, which is why it is captured rather than thrown away.

        The handle is opened in append mode and truncated beforehand so the panel shows
        the current run rather than an ever-growing file.
        """
        engine_out = None
        if options.engine_log:
            try:
                with open(options.engine_log, 'w', encoding='utf-8', errors='replace') as handle:
                    handle.write('[%s] engine %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), ' '.join(command)))
                engine_out = open(options.engine_log, 'a', encoding='utf-8', errors='replace')
            except OSError as error:
                log(options.log, 'WARN could not open the engine log: %r' % (error,))
                engine_out = None
        """
        Force the engine to emit UTF-8, whatever its console code page is.

        Measured on this machine: Python on Windows encodes stdout/stderr with the
        console code page (cp936 here), while the plugin reads the captured log as UTF-8.
        The result was mojibake for every Chinese line the engine prints -- most visibly
        in its own "实际输入的目标文本" and in the socket errors it reports, which is
        exactly the text a reader needs when something goes wrong.

        The alternative -- decoding the file per-locale in the plugin -- would guess at a
        code page the plugin cannot see; telling the engine what to emit is exact.
        `PYTHONIOENCODING` covers the interpreter's own streams, and it is also compared
        by Python when a script reconfigures stdout, so it wins in both cases.
        """
        engine_env = dict(os.environ)
        engine_env['PYTHONIOENCODING'] = 'utf-8'
        engine_env['PYTHONUTF8'] = '1'
        try:
            child = subprocess.Popen(
                command, cwd=options.engine_root, env=engine_env,
                stdout=engine_out if engine_out is not None else subprocess.DEVNULL,
                stderr=subprocess.STDOUT if engine_out is not None else subprocess.DEVNULL,
                stdin=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW,
            )
        except Exception as error:
            log(options.log, 'ERROR spawn failed: %r' % (error,))
            return 1
        started_pid = child.pid
        owned = True
        log(options.log, 'engine pid %d' % started_pid)

        ready = False
        for _ in range(POLL_TRIES):
            if api_answers(base) or port_open('127.0.0.1', port):
                ready = True
                break
            if child.poll() is not None:
                log(options.log, 'ERROR engine exited early with code %s' % child.returncode)
                return 1
            time.sleep(POLL_SECONDS)
        log(options.log, 'ready=%s' % ready)
        if not ready:
            return 1

    # Written on every path, including adoption: the next DSH reads this to find
    # an engine a crashed predecessor left behind.
    write_pid_file(pid_file, {
        'api_pid': started_pid, 'dsh_pid': options.adopt_pid,
        'supervisor_pid': os.getpid(), 'server': base, 'started_at': time.time(),
        'owned': owned,
    })

    # --- bind the engine's lifetime to DSH -----------------------------------
    if options.adopt_pid <= 0:
        log(options.log, 'no DSH pid given; supervising without a lifetime bound')
        return 0
    if not process_alive(options.adopt_pid):
        log(options.log, 'DSH pid %d is already gone; nothing to bind to' % options.adopt_pid)
        if owned and started_pid:
            kill_tree(started_pid)
        return 0

    log(options.log, 'watching DSH pid %d every %.1fs' % (options.adopt_pid, WATCH_SECONDS))
    while True:
        time.sleep(WATCH_SECONDS)
        if not process_alive(options.adopt_pid):
            log(options.log, 'DSH pid %d exited' % options.adopt_pid)
            break

    if owned and started_pid:
        log(options.log, 'stopping engine pid %d' % started_pid)
        kill_tree(started_pid)
        # Confirm, then report. The engine holds the GPU, so a failure here is
        # worth a line in the log rather than silence.
        for _ in range(15):
            if not process_alive(started_pid):
                break
            time.sleep(0.4)
        log(options.log, 'engine stopped: %s' % (not process_alive(started_pid)))
    elif started_pid:
        log(options.log, 'engine pid %d was not started by this supervisor; leaving it running' % started_pid)
    else:
        log(options.log, 'no engine to stop')

    try:
        if os.path.exists(pid_file):
            os.remove(pid_file)
    except OSError:
        pass
    log(options.log, 'supervisor exit')
    return 0


if __name__ == '__main__':
    sys.exit(main())
