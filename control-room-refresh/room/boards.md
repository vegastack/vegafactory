# Boards

Project boards and the repos that mirror onto them. Labels stay the machine state; a board is a view. Several repos may share one board.

**One way only.** The board-mirror workflow reads a repo's state label and writes the board's Status field. Nothing reads the board back, so a card dragged by hand is cosmetic until the next label change.

Status options, in this order: waiting-on-operator · planning · queued · in-progress · ready-to-ship · Done.

| board | number | repos | notes |
|---|---|---|---|

No board exists yet. A repo with no row here keeps `board: none` in its dev.md, and the workflow does nothing.
