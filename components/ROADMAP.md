# The rest of the library

**16 built.** This is the list of what comes next, and it is a list of
*intentions* — nothing here exists yet, and nothing in it should be described to
anybody as available.

That distinction is the whole reason this is a separate file rather than a set
of manifests with a `planned` flag. A manifest is a promise the loader enforces:
it has files, tests, provenance and a check that proves it. Adding forty
manifests with no code behind them would make the library look four times larger
and be exactly as useful as it is today, and the first founder to click one
would learn not to trust the rest.

## How this list was chosen

From what the target projects actually need — SaaS dashboards, internal tools,
booking and approval apps, marketplace-lite. Each entry is written as the
problem, in the words a founder would use, because that is also what the matcher
reads.

The order is roughly by how often it comes up.

## Documents and files

| | The problem |
| --- | --- |
| `xlsx_import` | "Let people upload an Excel file", which is not the same job as a CSV — formulas, several sheets, merged cells |
| `spreadsheet_export` | "Download this table as a spreadsheet" |
| `image_resize` | "Make thumbnails of uploaded photos so pages load quickly" |
| `image_strip_metadata` | "Remove the location data from photos people upload before anyone else sees them" |
| `zip_bundle` | "Download all of these as one file" |
| `document_template_fill` | "Produce a contract from a template with their details filled in" |
| `qr_code` | "Put a QR code on the ticket" |
| `barcode_scan` | "Scan a barcode with a phone camera" |
| `virus_scan` | "Check uploaded files for malware before anyone opens them" — needed the moment strangers can upload |

## Getting data in and out

| | The problem |
| --- | --- |
| `address_lookup` | "Find their address from a postcode instead of making them type it" |
| `geocoding` | "Turn an address into a point on a map" |
| `webhook_sender` | "Tell another system when something happens here" |
| `api_key_issuing` | "Let customers use our API, with keys they can revoke" |
| `data_export_all` | "Download everything in my account" — related to privacy export, but a product feature rather than an obligation |
| `import_dry_run` | "Show me what would change before I commit to it" |

## Scheduling and time

| | The problem |
| --- | --- |
| `availability_calendar` | "Show which slots are free and let somebody book one" |
| `recurring_schedule` | "Every second Tuesday" — the part everybody underestimates |
| `timezone_display` | "Show times in the viewer's own timezone without getting it wrong" |
| `reminder_scheduling` | "Email them the day before" |
| `working_hours` | "We are closed at weekends and on bank holidays" |

## Money, beyond taking payment

| | The problem |
| --- | --- |
| `invoice_numbering` | "Sequential invoice numbers with no gaps", which most tax authorities require |
| `discount_codes` | "Give them 20% off with a code" |
| `refund_flow` | "Give somebody their money back, and record why" |
| `usage_metering` | "Charge per seat, or per thing used" |
| `tax_rates` | "Charge the right VAT for where the customer is" — needs care and probably a vendor |

## People and communication

| | The problem |
| --- | --- |
| `invite_flow` | "Invite a colleague by email and let them join" |
| `password_reset` | "I forgot my password" — currently a named gap in the auth component |
| `email_verification` | "Confirm the address is really theirs" |
| `two_factor_auth` | "Make people use a code from their phone as well" |
| `in_app_notifications` | "A bell with a number on it" |
| `comment_thread` | "Let people discuss a record" |
| `mentions` | "Type @ and notify somebody" |

## Showing things to people

| | The problem |
| --- | --- |
| `data_table` | "A table I can sort, filter and page through" — the single most requested screen |
| `search_within_app` | "A search box that finds things across the app" |
| `saved_views` | "Remember the filters I use every day" |
| `chart_basics` | "Show it as a graph" |
| `activity_feed` | "What has happened recently" |
| `empty_states` | "What a screen says before there is anything on it" |
| `bulk_actions` | "Select several and do the same thing to all of them" |

## Operations

| | The problem |
| --- | --- |
| `feature_flags` | "Turn this on for one customer first" |
| `maintenance_mode` | "Put the site behind a notice while we fix something" |
| `rate_limiting` | "Stop one person hammering the API" |
| `soft_delete_restore` | "Undo a deletion" |
| `database_backup_check` | "Prove the backups actually restore" — the check, not the backup |

## What would make one of these real

The same bar as the sixteen that exist. Not "it works on my machine":

1. A manifest with provenance and a licence.
2. Files, with the implementation and tests separated from the parts meant to be
   edited.
3. Contract tests that run **in the project it was installed into**, and that
   test the thing that actually goes wrong — not the happy path.
4. `solves` phrases in a founder's words, or the matcher will never surface it.
5. A `limitations` list. A component that claims no limits has not been thought
   about.
6. `npx tsx packages/component-library/scripts/verify-components.ts` passing.

Anything that cannot clear that is `provisional` at best, and says so on its own
card.
