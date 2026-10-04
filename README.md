# XYi Timesheeter

> Taking this project over? Start with **HANDOVER.md**, then **WRIKE.md** for
> how data flows in from Wrike.

A React timesheet tracker. This folder contains everything needed to run it
locally and deploy it online for free.

## Prerequisites (one-time)

You need **Node.js** installed. Check by opening a terminal and running:

```bash
node -v
```

If you see a version number (v18 or higher), you're set. If not, download the
"LTS" version from https://nodejs.org and install it.

## Run it on your own machine

From inside this folder, in a terminal:

```bash
npm install      # downloads all the libraries (one time, ~1 min)
npm run dev      # starts the app
```

It will print a local address like `http://localhost:5173`. Open that in your
browser. Edits to the code reload instantly.

To stop the server, press `Ctrl + C` in the terminal.

## Build a production version (optional)

```bash
npm run build    # creates an optimized "dist" folder
npm run preview  # serves that build locally to test it
```

## Deploy online for free

See DEPLOY.md for the full walkthrough.
