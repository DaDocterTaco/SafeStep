# Automatic Web Risk configuration

The server uses `WEB_RISK_API_KEY` for Google Web Risk. `SAFESTEP_WEB_RISK_AUTHORIZED` and `SAFESTEP_WEB_RISK_DAILY_LIMIT` belong to the operator-controlled budget configuration. The runtime enforces a local budget ledger and user consent for eligible public URL checks. Gemini uses its own credentials and controls.

Keep credentials, pairing tokens and ledgers on the operator's machine. Follow the [keyless build instructions](../SETUP.md) to verify this source checkpoint. The Git verification runs use fixtures and do not call either provider.
