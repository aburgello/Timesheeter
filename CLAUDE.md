# Working on TimeHub

Read HANDOVER.md first, and WRIKE.md before touching anything that talks to
Wrike. Run `npm run check` before calling a change done.

## Comments

Comments say what is true now and why. Keep them short.

- Write a comment when the reason for some code isn't obvious from the code:
  a Wrike quirk, a rule that looks over-careful, an order that matters. One
  to three lines is usually enough.
- Don't narrate history. "This used to…", what broke, when, and how many rows
  it affected belong in the commit message. `git log` and `git blame` find
  them there, and they don't go stale in the file.
- Don't restate the code. A comment that says what the next line does is
  noise.
- When you change code, fix or delete any comment it makes wrong.
- If something needs a long explanation, put it in WRIKE.md or HANDOVER.md
  and point to it.

## Commit messages

The commit message is where the story goes: what was wrong, how it showed up,
and why this fix. Be as specific as you like there.
