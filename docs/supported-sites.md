# SafeStep coverage

| Stage 2 workflow | Supported route | Completion and limits |
| --- | --- | --- |
| [English Wikipedia: Phishing](https://en.wikipedia.org/wiki/Phishing) | Tools → Cite this page → APA | Confirms the article from the local citation route and article heading, and checks that the APA section is in view. Other articles, languages and layouts are outside this demo. |
| [VideoLAN](https://www.videolan.org/) | VLC → Download → Windows | Confirms the Windows information page and heading on the exact HTTPS origin. The installer is outside the workflow. |
| Local address inspection | Current page, suggested link, or a selected inspected control | Parsed host, registration boundary, scheme, port and visible label. A matching address is not a safety assessment. Later redirects and script-only destinations are unknown. |

See the [Stage 2 builder report](STAGE_2_BUILD_REPORT.json) for the fingerprint and actual Chrome results. Test unusual addresses without visiting them at the [harmless address lab](http://localhost:4174/addresses) after starting `npm run fixture`.

## Foundation coverage (retained)

| Page or workflow | Implemented support | Evidence and limits |
| --- | --- | --- |
| Local practice desk, `http://localhost:4174/` | Inspect visible public controls, manually outline a selection, clear/restore, re-inspect | Verified in real Chrome with equivalent fixture URLs on ephemeral loopback ports. This is a labelled practice page, not a live shopping, download or fraud finding. |
| Second practice document, `/next` | Separate document and temporary references; same-origin navigation | Verified in Chrome. A previous reference cannot select the new control. |
| Ordinary HTTP(S) top-level pages | Generic inspection primitives after toolbar invocation or explicit optional site access | No claim of universal coverage. Up to 32 visible links/buttons from a bounded DOM walk, no closed shadow roots, frames or private form values. A script-only destination is unknown. Static link information cannot predict redirects. |
| Embedded frames, browser-internal pages and the Chrome Web Store | Unsupported | Top-level only. The fixture reports skipped frames; a restricted Chrome page was tested. |
| Logged-in sites | Same user-selected tab and its normal content script; no credentials copied | No private account, login, real site workflow or user study was tested. |
| Later shopping, download-protection and reputation work | Planned | See [all nine feature statuses](feature-status.json) and [source access](source-access.md). |

Site preferences retain an exact origin. Chrome’s host grants and content-script match patterns cover the scheme and hostname across **all ports**; the coordinator also checks the selected origin and the current top-level document before reading or highlighting. A dynamically registered bridge does not read controls until a validated inspection request. The mandatory loopback API host is not an authorization to inspect arbitrary loopback tabs.
