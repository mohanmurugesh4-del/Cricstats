# CricStats

Ball-by-ball cricket scoring engine (`cricstats.py`, standard library only) and its website (`index.html`).

Run the scorer in the terminal:

    python cricstats.py

The website is a static page. It runs a JavaScript port of the same event model, so the live board and scorecards are computed in the browser.

## Deploy

Pushes to `main` publish the site with GitHub Pages through `.github/workflows/pages.yml`.
Enable it once in the repo under Settings → Pages → Build and deployment → Source: GitHub Actions.
