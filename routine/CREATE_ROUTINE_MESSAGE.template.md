Please create a new Routine for yourself with these settings:

- Name: xscout webhook research
- Trigger: Webhook (incoming HTTP POST with a JSON body)
- Instructions: the full text between the two marker lines below, copied VERBATIM. Do not summarize, shorten, translate or reformat it; the Python script inside must stay byte-for-byte identical.
- Unattended runs: running `python3 /tmp/xscout/deliver.py ...` on your cloud computer and its HTTPS requests to api.github.com should not require my approval, because nobody watches these runs. If that needs an auto-approval rule, set it up only for that command.
- The script reads the secret XSCOUT_GITHUB_TOKEN that I saved for you earlier; make sure routine runs can access it as an environment variable.

When you're done, reply with: (1) the webhook URL, (2) which kind of auth the webhook uses (a `whsec_...` signing secret or a Bearer key such as `crsr_...`) and where I can view it in the app. Do NOT paste the secret/key itself into this chat. (3) Confirm the instructions were saved verbatim (character count is fine).

===== BEGIN ROUTINE INSTRUCTIONS =====
{{INSTRUCTIONS}}
===== END ROUTINE INSTRUCTIONS =====
