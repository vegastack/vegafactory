---
"@vegastack/vegafactory": patch
---

A Linux worker survives the operator logging out, and says so at the moment it can still be fixed.

- `worker enable` runs `loginctl enable-linger` before it loads anything. A `--user` service lives inside a login session and systemd ends that session with the last login, so without linger an always-on worker died at the next logout — quietly, and hours later. An account that may not grant linger to itself stops the command with the failing line, rather than leaving a unit that works until someone logs out.
- `worker disable` leaves linger alone: it is user-wide and other services on that account may rely on it.
- The systemd unit writes `worker.log` and `worker.err.log` into the repository's `.vegastack/.tmp/worker/`, the same two files the macOS one does. The path was already being passed to the Linux branch and dropped, so the log this product tells people to read never appeared there. The unit redirects its streams, so those files are the whole of the worker's output on Linux and the journal holds only systemd's own messages about the service.
- The onboarding checklist covers both: how to confirm linger, what to do when the account cannot set it, and where Linux logs go.
