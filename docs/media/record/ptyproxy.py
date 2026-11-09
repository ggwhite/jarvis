#!/usr/bin/env python3
"""Run a command in a pty and forward the terminal to it, plus a FIFO.

Usage: ptyproxy.py FIFO CMD [ARGS...]

Everything written to FIFO reaches the command's input in one write, so a
driver script can send whole escape sequences (SGR mouse clicks, Enter)
without the terminal splitting them. The recorder (vhs) stays the real
terminal: output, window size and keys pass straight through.
"""
import fcntl
import os
import pty
import select
import signal
import sys
import termios
import tty


def copy_winsize(src_fd: int, dst_fd: int) -> None:
    try:
        size = fcntl.ioctl(src_fd, termios.TIOCGWINSZ, b"\0" * 8)
        fcntl.ioctl(dst_fd, termios.TIOCSWINSZ, size)
    except OSError:
        pass


def main() -> int:
    fifo, argv = sys.argv[1], sys.argv[2:]
    if not os.path.exists(fifo):
        os.mkfifo(fifo)
    pid, master = pty.fork()
    if pid == 0:
        os.execvp(argv[0], argv)
    stdin = sys.stdin.fileno()
    copy_winsize(stdin, master)
    signal.signal(signal.SIGWINCH, lambda *_: copy_winsize(stdin, master))
    old = termios.tcgetattr(stdin)
    tty.setraw(stdin)
    # O_RDWR keeps the FIFO open between driver writes, so select never sees EOF
    ff = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
    try:
        while True:
            try:
                ready, _, _ = select.select([stdin, master, ff], [], [])
            except InterruptedError:
                continue
            if master in ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                os.write(sys.stdout.fileno(), data)
            for fd in (stdin, ff):
                if fd in ready:
                    data = os.read(fd, 65536)
                    if data:
                        os.write(master, data)
    finally:
        termios.tcsetattr(stdin, termios.TCSAFLUSH, old)
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    sys.exit(main())
