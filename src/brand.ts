// Who this setter runs for: the one file that names the account, the business and the community. Everything else
// reads it. Filled in during setup (SETUP.md step 2); `npm run deploy` refuses while a REPLACE value is left.

// The Worker's public URL: tracked links, flow buttons and alert taps point here (cron runs have no request to read it
// from). You learn it on the first deploy (SETUP.md step 4): https://fewchat.<your-subdomain>.workers.dev
export const ORIGIN = "https://fewchat.REPLACE-SUBDOMAIN.workers.dev";
export const IG_HANDLE = "REPLACE_IG_HANDLE"; // the Instagram account, no @
export const BUSINESS = "REPLACE_BUSINESS_NAME"; // who operates the app, on the privacy policy and terms (your LLC, or your name)
export const SITE = "REPLACE_WEBSITE"; // e.g. example.com
export const CONTACT_EMAIL = "REPLACE_CONTACT_EMAIL"; // privacy + data deletion requests
export const COMMUNITY = "REPLACE_COMMUNITY_NAME"; // what the setter sells, as the console and the customer line name it
// The Skool group's URL slug(s), e.g. skool.com/my-group → "my-group". The first is live (join + roster reads); add
// old slugs after it if you ever renamed the group, so old threads still count as "sent the link".
export const SKOOL_GROUPS = ["REPLACE-SKOOL-SLUG"];

// "skool.com/<slug>" for any of the slugs, plus our own tracked /l/ links.
export const LINK_RE = new RegExp(`skool\\.com\\/(${SKOOL_GROUPS.join("|")})|\\/l\\/`, "i");
// SQL: does m.text (or text) carry a Skool link for one of the slugs?
export const skoolLinkSql = (col: string) => SKOOL_GROUPS.map((g) => `instr(${col}, 'skool.com/${g}') > 0`).join(" OR ");
