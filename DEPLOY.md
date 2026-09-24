# Deploying Avelie behind Cloudflare Access

Twelve steps. Do them in order. The middle column is yours; the right column says what Claude can do for you instead, which depends on the token described at the end of this file.

Before step 1, run `npm test` once on your machine so the canon is built and the master hashes pass.

| # | You do | Claude does |
|---|---|---|
| 1 | Run `npx wrangler login` and finish the login in the browser that opens. | Nothing. A browser login is yours. With a CLOUDFLARE_API_TOKEN in its environment Claude skips this step. |
| 2 | The D1 database `avelie` already exists and its id is in wrangler.jsonc (created 2026-09-24). Only if you ever start from a different account: run `npx wrangler d1 create avelie` and paste the printed `database_id` into wrangler.jsonc. | Can run the create command and paste the id. |
| 3 | Run `npx wrangler r2 bucket create avelie-media`. | Can run it. |
| 4 | Run `npm run db:remote`. This applies `0001_init.sql` and the generated `0002_seed.sql` to the live database. | Can run it. |
| 5 | Create the two keys, then store them: run `npx wrangler secret put ANTHROPIC_API_KEY` and paste the Anthropic key at the prompt; run `npx wrangler secret put OPENAI_API_KEY` and paste the OpenAI key. | Never creates a key. Can run the two `secret put` commands only if you have also placed the key values as secrets in Claude's build environment. |
| 6 | Run `npm run deploy`. It runs `npm test` and then `wrangler deploy`. `workers_dev` stays `false`, so the Worker exists but has no public address yet. | Can run it. |
| 7 | Create the Access application. Sub-steps 7a to 7h are below this table. | Nothing. This step stays in your hands. |
| 8 | Paste the AUD tag from 7g into wrangler.jsonc as `vars.ACCESS_AUD`, then run `npm run deploy` again. | Can paste and deploy once you give it the tag. |
| 9 | Run the two proofs below this table. | Can run them and read the result to you. |
| 10 | Open `https://<host>/` in a browser, type your email, type the code that arrives by email, send her one message, watch the reply land. | Nothing. The code arrives in your inbox. |
| 11 | Backups: run `mkdir -p backups` once, then `npm run export:remote` for a SQL dump into `backups/` (git ignores that folder), and use State > Export > Export JSON in the app for the JSON that Import accepts. | Can run the SQL export. |
| 12 | Rollback: run `npx wrangler rollback` and pick the previous deployment at the prompt. | Can run it. |

## Step 7 in detail: the Access application

Do one action per line.

7a. Decide the hostname. Either attach a custom domain: in the Cloudflare dashboard open Workers & Pages, open `avelie`, open Settings, open Domains & Routes, click Add, choose Custom domain, enter `avelie.<your domain>`. Or plan to use the workers.dev address, which you switch on only in 7h, after Access exists.

7b. Open Zero Trust in the dashboard sidebar. Open Access. Open Applications. Click Add an application. Choose Self-hosted.

7c. Name it `Avelie`. Under Application domain enter the hostname from 7a. For workers.dev that is `avelie.<your account subdomain>.workers.dev`.

7d. Under Identity providers untick everything except One-time PIN.

7e. Set Session duration to 24 hours.

7f. Add a policy. Name it `Owner`. Action: Allow. Under Include choose Emails and enter the OWNER_EMAIL that is in wrangler.jsonc. Save the policy, then save the application.

7g. Open the application you just made. On its overview find the Application Audience (AUD) Tag. Copy it. That string goes into wrangler.jsonc in step 8.

7h. Only if you chose workers.dev in 7a: change `"workers_dev": false` to `true` in wrangler.jsonc. The deploy in step 8 switches the address on, and by then Access is already in front of it.

The team domain is already set in wrangler.jsonc as ACCESS_TEAM_DOMAIN. Do not change it unless your Zero Trust team name changes.

## Step 9 in detail: the two proofs

Run these from any machine. Replace `<host>` with the hostname from 7a.

```
curl -sI https://<host>/
curl -sI https://<host>/api/me
```

The first must answer `302` with a `location:` header that points at your cloudflareaccess.com team domain. That is Access sending a stranger to the login page.

The second must answer `302` or `401`. It must never answer `200`. A `200` here would mean the API is open to the world; stop and fix step 7 before doing anything else.

If Access were somehow missing, the Worker on its own answers `503` while ACCESS_AUD is empty and `401` once it is set, because it trusts no identity it cannot verify. That is the second lock. The proof above checks the first one.

## Cost ceilings

From the build brief, as of September 24, 2026. Confirm every number on the Cloudflare pricing pages at deploy time; they move.

- Workers Free: 100,000 requests per day.
- D1 Free: 5 million rows read per day, 100,000 rows written per day, 5 GB storage. Since September 1 a day that runs past the free row limits fails until the reset instead of silently continuing.
- Workers AI: 10,000 free Neurons per day. Some models need the paid plan, and quality varies. Workers AI is an option in the Model panel, not the default.
- API model calls (Anthropic for text, OpenAI for photos) are billed by those companies separately. The app's own caps are what stop that spend; see docs/COSTS.md.
- R2 storage for photo candidates is small at this scale but is its own line on the Cloudflare bill.

These are capacity ceilings, not a promise that the app runs for free.

## What Claude can run with a token

If you give Claude a `CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID`) as secrets in its build environment, it can run steps 2, 3, 4, 6, 8, 9, 11 and 12 without you. Make the token from the "Edit Cloudflare Workers" template and add D1 Edit and Workers R2 Storage Edit to it.

Claude does not create your Anthropic or OpenAI keys and does not create the Access application. Step 5 becomes Claude's only if the two key values are also in its build environment as secrets; it never types a key into a file or a log. Step 10 is yours because the login code goes to your email.
