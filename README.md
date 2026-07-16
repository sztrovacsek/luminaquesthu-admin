# Lumina admin — task review app

A static (no build step, no backend) web app for teachers to review, edit,
and duplicate AI-generated tasks, talking directly to Supabase.

## 1. Configure

Edit `config.js` with your Supabase project's URL and anon (public) key —
find both under **Project Settings → API**. The anon key is *meant* to be
public in a client-side app like this one: it grants no access on its own.
Every permission is enforced by the Row Level Security policies on your
tables, not by keeping this key secret.

## 2. Apply the role/RLS migration

Some teachers will have a quest manager role, which means they can edit
AI-generated tasks in the quests. Grant this role in Supabase. Here's how.
Promote a teahcer once they're invited:
```sql
update public.profiles set role = 'quest_manager' where id =
  (select id from auth.users where email = 'kerdesfelelos@iskola.hu');
```

*(There's an earlier migration, `20260716130000_relax_staff_task_access.sql`,
from a first pass at this that let any teacher edit any task — it's
superseded by this one. If you already applied it, this migration cleanly
replaces its policies; you don't need to undo it first.)*

## 3. Authentication — recommended approach

You haven't picked an auth method yet, so here's a concrete recommendation
for this specific situation: a small, known, trusted set of teacher-admins,
not a general public sign-up.

### Use Supabase Auth with magic links (email OTP), not passwords

- **No password reset flows, no credential leaks to manage.** A teacher
  enters their email, gets a one-time sign-in link, clicks it, they're in.
  This app's login screen already implements this
  (`supabase.auth.signInWithOtp`).
- Passwords are the wrong tool here: you have a handful of trusted users,
  not thousands of self-service signups, so the extra friction of
  "remember a password for a tool you use twice a week" buys you nothing.

### Turn off public sign-up — invite teachers explicitly

By default, Supabase lets anyone request a magic link and it silently
creates a new account for them (with `role = 'student'` from the
`handle_new_user` trigger — harmless, but not what you want for the admin
tool). Two ways to keep this to a closed set of teachers:

1. **Simplest: disable public sign-ups** in **Authentication → Settings**
   in the dashboard, and instead create each teacher's account yourself via
   **Authentication → Users → Invite user** (or the
   `supabase.auth.admin.inviteUserByEmail()` API from a trusted script —
   never from this static app, since that requires the `service_role` key,
   which must never ship to a browser). The invited teacher gets an email,
   sets things up, and can then use magic-link sign-in going forward.
2. **After inviting them, promote their role.** A new user's `profiles`
   row defaults to `role = 'student'`. Run one SQL statement per teacher:
   ```sql
   update public.profiles set role = 'teacher' where id =
     (select id from auth.users where email = 'tanar@iskola.hu');
   ```
   (or `role = 'admin'` for the smaller group who should also be able to
   delete tasks, not just archive them). This app already reads that role
   and shows an "access denied" screen to anyone still at `student`.

### If your teachers already have school Google accounts

If the school (or your team) uses Google Workspace, **Google OAuth** is a
nice upgrade over magic links later — one click, no email round-trip, and
you can restrict it with Google's `hd` (hosted domain) parameter so only
`@your-school.hu` accounts even show up as an option. It's more setup
(a Google Cloud OAuth consent screen) than magic links, so it's worth
adding once you have more than a handful of teachers, not on day one.

### What NOT to do

- Don't build your own password/session system — Supabase Auth already
  handles this correctly (secure token storage, refresh, etc.) and
  reinventing it is where most home-grown admin tools get security wrong.
- Don't gate access by hiding the app's URL — it's a static site, the URL
  isn't a secret, and anyone could find it. Access control has to happen
  at the data layer (RLS + role check), which is what's already in place.

## 4. Run it

Any static file host works — this is plain HTML/CSS/JS, no build step:

- **Local testing**: `npx serve .` (or any static server) — not
  `file://`, since Supabase's auth redirect needs a real `http(s)://` origin.
- **Production**: Netlify, Vercel, Cloudflare Pages, or GitHub Pages — drag
  the folder in, or connect the repo. Whichever domain you deploy to,
  add it as a **Redirect URL** in Supabase's **Authentication → URL
  Configuration**, or magic links won't be able to complete sign-in.

## What the app does

- Pick a world → quest, see all its tasks with difficulty, type, status, XP.
- **Szerkeszt (Edit)** — opens a form tailored to the task's type (numeric
  fields, multiple-choice options + correct answer, true/false, ordering
  steps, or a free-text sample solution), plus shared fields: stem,
  hints, difficulty, XP, and status.
- **Másol (Duplicate)** — clones a task into a new draft you can tweak and
  save as a separate row, without touching the original.
- **+ Új feladat (New task)** — blank task for the selected quest; only
  here can you choose the task type, since changing type after creation
  would leave `content`/`answer_key` in an inconsistent shape.
- **Archivál (Archive)** — available on any task you can edit (your own,
  or any task if you're a quest manager/admin). Soft-removes it (`status =
  'archived'`) rather than hard-deleting it, so nothing referencing it
  (e.g. a boss fight) breaks. Hard delete isn't exposed in this app —
  only an admin can do that directly in the database, on the rare
  occasion it's actually needed.
- Tasks you can't edit (someone else's, and you're not a quest manager or
  admin) open in a read-only view instead — every field is visible but
  disabled, with no Save button, so you can inspect an AI-generated task's
  hints and answer key without being offered an edit the database would
  reject anyway.
- Ordering tasks: enter the steps in the *correct* order — the app
  shuffles them before saving, so what you type isn't what students see.
