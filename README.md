# CricStats

Ball-by-ball cricket scoring. The repo has:

- `cricstats.py`: the terminal scorer (standard library only). Run `python cricstats.py`.
- `index.html`, `app.js`, `engine.js`: the website. Match list, match pages with commentary, scorecards and squads, and admin scoring.
- `supabase.sql`: the database, login and access rules.
- `config.js`: your Supabase project keys.

## Roles

- **Viewer:** signs in and watches matches that an admin has made visible. Can't change anything.
- **Admin:** registers with an invite code. Starts matches, scores them, and renames players. Only the admin who starts a match can see or change it while it is private.
- A match starts **private**. Tick "Visible to viewers" to share it, and untick to hide it again.

## One-time setup

1. **Create a Supabase project** at supabase.com (free tier).
2. **Create the database:** open *SQL Editor → New query*, paste the whole of `supabase.sql`, and click **Run**.
3. **Add an admin invite code:** at the bottom of `supabase.sql` there is a commented line. Copy it, replace `MY-SECRET-CODE` with your own private code, and run it on its own. Share that code only with people who should be admins.
4. **Connect the site:** in Supabase go to *Project Settings → API* and copy the **Project URL** and the **anon public** key into `config.js`.
5. **Sign-in emails:** under *Authentication → Providers → Email* you can turn off "Confirm email" for quick testing. Leave it on for a public site.
6. **Publish:** push to `main`. GitHub Pages deploys the site (see the Pages setup in the repo's Settings).

## Notes

- The anon key in `config.js` is meant to be public. The security comes from the rules in `supabase.sql`.
- Scores are recalculated from the stored deliveries, so renaming a player never changes a score.
- Undo removes the last delivery, which keeps the scorecard accurate.
- Viewers see live updates without refreshing.
