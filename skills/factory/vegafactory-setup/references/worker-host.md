# Worker host facts

Vendor behaviour a worker box depends on, with the source and the date each was checked. Kept here rather than in the checklist because these are other people's defaults: they move on someone else's schedule, and a number written into a procedure is a number nobody re-checks.

## systemd — a user service outlives its logins only with linger

A `--user` service runs inside a login session. When the last session for that account ends, logind stops the user's whole manager and takes the service with it — so an always-on worker dies at the operator's next logout, quietly, hours later.

`loginctl enable-linger <user>` is what keeps the manager running with no session. It is per-user and gated by polkit, so an account may not be able to grant it to itself; an administrator runs it once.

- Source: `loginctl(1)`, <https://www.freedesktop.org/software/systemd/man/latest/loginctl.html> — checked 21-09-2026 against systemd 257.

## systemd — `UserStopDelayUSec` is why a logout drill has to wait

After the last session ends, logind keeps the user's manager alive for `UserStopDelayUSec` before stopping it. **The default is 10 seconds**, it is settable in `logind.conf`, and it is named in microseconds.

A drill that checks the service immediately after logout therefore finds it `active` whether or not linger is set — inside that window every worker passes. The checklist reads the value off the box with `busctl` and waits it out rather than assuming the default, because a box configured with a longer delay is exactly where the assumption fails.

- Source: `logind.conf(5)`, <https://www.freedesktop.org/software/systemd/man/latest/logind.conf.html> — checked 21-09-2026 against systemd 257.

## systemd — `StandardOutput=append:` redirects, it does not copy

`append:<path>` sends the service's stdout to that file *instead of* the journal. `journalctl -u <unit>` then shows systemd's own messages about the unit and nothing the service printed.

This is the trade the worker unit makes for log-file parity with macOS, and it is why the checklist sends a reader to the log files rather than the journal.

- Source: `systemd.exec(5)`, <https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html> — checked 21-09-2026 against systemd 257.
