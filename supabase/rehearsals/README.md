# Rehearsals

A rehearsal applies a migration inside a transaction, tests it against the
live tables, and then fails on purpose so that everything is undone. The
error message it ends with carries the test results.

Run one in Supabase's SQL editor before applying a migration that changes a
busy table. The editor will warn that the script has destructive statements;
read them, then run it. Nothing is kept.
