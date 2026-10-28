# DeepSeek Harness · Sign in with ChatGPT

[简体中文](README.md) | **English**

<img src="assets/icon.webp" alt="DeepSeek girl eating ChatGPT Tokens" width="160" />

Use your own ChatGPT plan in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Install the plugin, sign in independently with **Continue with ChatGPT**, authorize plan usage, and choose an available model in DSH.

This is an unofficial local plugin with MIT-licensed source code. Each user authorizes their own account; the package contains no accounts, credentials, or shared allowance. It follows [OpenAI's open-source sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in). No API key is required, and it does not read Codex or Pi login files.

## Requirements

| Component | Version / requirement |
| --- | --- |
| Plugin | **0.1.5-daybreak** |
| DeepSeek Harness | 0.2.1 prereleases from **0.2.1-rc.3**, and the 0.2.1 stable release; **0.2.0-rc.2** retained |
| pi-ai used by DSH | **1.1.x** or **0.87.1**, supplied by the host |
| Verified desktop platform | macOS; other platforms have not been verified |
| ChatGPT account | Eligible for OpenAI's current plan integration, with permission granted to use the plan |

This update was tested with DSH **0.2.1-rc.3** and pi-ai **1.1.0**. Later versions within the declared ranges are allowed to load but have not been tested. Previously supported DSH **0.2.0-rc.2** / pi-ai **0.87.1** is retained and was not dynamically retested for this update.

Models and limits depend on what OpenAI returns for your account. “ChatGPT Pro Plan” on the icon is illustration text: it does not mean the plugin is Pro-only or includes unlimited usage. Recheck compatibility after upgrading DSH.

For details on the host's pi-ai dependency, the implementations this plugin reuses, and version compatibility, see [Relationship with DSH and pi-ai](#relationship-with-dsh-and-pi-ai) below.

## Install

The current version is **0.1.5-daybreak**, including Desktop compatibility fixes and experimental Fast / Daybreak settings. Download **`dsh-chatgpt-plan-0.1.5-daybreak.tgz`** from the [GitHub Release](https://github.com/yeahx/dsh-chatgpt-plan/releases/tag/v0.1.5-daybreak), or follow [Build from source and develop](#build-from-source-and-develop) below. GitHub's automatically generated Source code archives cannot be installed directly as plugin packages.

Quit DSH completely. On macOS, run this in Terminal, assuming the file is in Downloads and the App is in `/Applications`:

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add "$HOME/Downloads/dsh-chatgpt-plan-0.1.5-daybreak.tgz"
```

DSH resolves runtime dependencies, including `undici`, during installation, so access to the package registry is required. Do not replace individual source files. Reopen DSH and confirm `dsh-chatgpt-plan` is enabled in the plugin list.

Adjust the App path if needed. For another DSH profile, replace `desktop` with its name; each profile requires separate installation and authorization.

## Sign in and start using a model

1. Open DSH **Settings → ChatGPT 套餐 (ChatGPT plan) → Continue with ChatGPT**.
2. Click **Continue with ChatGPT** on the local account page to open OpenAI's authorization page.
3. Confirm the account and app name **DeepSeek Harness**, then grant plan usage if desired. Identity-only sign-in does not enable inference.
4. Return to DSH and select a model under **ChatGPT 套餐（独立授权）** (“ChatGPT plan — independent authorization”).
5. Send a message. DSH continues to manage history, local tools, file permissions, and streaming display.

Always open the account page from DSH Settings. It listens on loopback only, prefers port `18762`, and chooses another available port if necessary. A fixed URL is not a shared management endpoint for all instances. The plugin UI currently uses Chinese labels; this README provides their English meanings.

## Add and switch accounts

1. Click **添加账号 · Continue with ChatGPT** (“Add account”). Confirm or switch accounts on OpenAI's page.
2. Authorize each account separately. Use **修改备注** (“Edit label”) for names such as “Personal Pro” or “Work”.
3. Click **切换到此账号** (“Switch to this account”), then select a model available to that account in DSH.

Switching cancels the previous account's in-progress requests and refreshes the model list. Registrations keep separate credentials and models, even when email addresses match. Only one account is active at a time. The plugin does not automatically rotate accounts, pool allowances, or fall back to another account after an error or sign-out.

Switching does not clear DSH conversation history. Start a new conversation to separate chat content.

### Per-account-configuration host IDs (branch preview)

The `codex/per-account-host-id` branch treats each local account configuration as a separate logical host. It generates and persists an independent random `urn:uuid:…` and sends it as `ext_agent_host_id` during authorization. Reauthorization, sign-out, account switching, and restarts reuse that configuration's ID; it is never rotated per request. New registrations persist their identifier before opening the authorization page, including when registrations run concurrently.

On first load, legacy storage is upgraded to format 2. Each account without its own identifier receives one, while credentials, models, labels, and Fast / Daybreak choices are preserved. Existing tokens are not reissued automatically: the new identifier is sent on the account's next reauthorization and cannot undo past associations. Older plugins cannot directly read format 2; retain a backup of the old configuration before upgrading rather than opening migrated storage with an older plugin.

This change is not in the published `v0.1.5-daybreak` package. It changes the plugin's definition of a host boundary. [OpenAI's documentation](https://developers.openai.com/siwc/token-sharing-open-source) defines a host ID as an identifier for a runtime whose lifecycle the app determines, requiring stability within that lifecycle. Live server compatibility during reauthorization has not been verified for this branch, and separate host IDs do not guarantee that accounts cannot be associated.

## Fast / Daybreak inference settings (experimental)

These controls ship in the **0.1.5-daybreak** prerelease and are merged into this repository's `main`. Earlier 0.1.4 packages do not contain them.

Open **管理账号、网络与推理设置** (“Manage accounts, network, and inference”) from DSH Settings. In the account card's **推理设置（实验性）** (“Inference settings — experimental”), choose the speed and Daybreak mode, then click **保存推理设置** (“Save inference settings”). Each account keeps its own choices. Changes apply to that account's subsequent requests and do not interrupt an active response stream.

| Choice | Request behavior |
| --- | --- |
| Speed: 默认（跟随服务端） — Default | Omit `service_tier` |
| Speed: 标准 — Standard | `service_tier: "default"` |
| Speed: Fast | `service_tier: "fast"` |
| Daybreak: 默认（跟随服务端） — Default | Omit `access_programs` |
| Daybreak: 关闭 — Off | `access_programs.cyber: "standard"` |
| Daybreak: Daybreak Blue | `access_programs.cyber: "daybreak_blue"` |
| Daybreak: Daybreak Red | `access_programs.cyber: "daybreak_red"` |

Both choices start at Default, preserving existing request behavior. Fast may consume more allowance; OpenAI determines actual speed, usage, and availability. Both features require support for the account and selected model. A successful save confirms local persistence, not server acceptance. Selecting Daybreak grants no additional access. Blue / Red request values must match the model; the plugin does not infer them from account approval, change models, or silently retry at a lower tier when unsupported. Adjust the choices or restore Default if the service returns a relevant error.

The fields follow the official [Fast mode](https://developers.openai.com/api/docs/guides/fast-mode) and [Daybreak](https://developers.openai.com/api/docs/guides/daybreak) documentation. Those API documents do not guarantee availability through this plugin's Sign in with ChatGPT (SIWC) OAuth plan access: **live SIWC Fast / Daybreak inference has not been verified for this feature**. The plugin does not switch to API-key billing, and [SIWC preview restrictions](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) still apply.

## Network settings

Under **网络连接** (“Network connection”) on the account page, choose:

| Mode | Behavior |
| --- | --- |
| 使用环境代理设置 — Environment proxy | Reads `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY`, including lowercase variants; does not automatically read macOS system proxy settings |
| 直接连接 — Direct | Connects without a proxy |
| 指定 HTTP(S) 代理 — Custom proxy | Accepts a URL such as `http://127.0.0.1:7890`; SOCKS, credentials, paths, and query parameters are unsupported |

Saving settings cancels current plugin requests. These settings affect this plugin only; browser authorization uses the browser's own network configuration. Apps launched from Finder may not inherit Terminal proxy variables, so configure a custom HTTP(S) proxy when needed.

## Usage, renewal, and sign-out

Click **管理 ChatGPT 用量与额度** (“Manage ChatGPT usage and limits”) or open [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage). The plugin has no total remaining allowance dashboard; OpenAI manages usage and access limits.

Credentials are renewed when needed, respecting the earliest refresh time returned by the service. Temporary network errors preserve an otherwise valid login; expired credentials are not used. An inference HTTP 401 can trigger one refresh and retry. A response stream that has already started is not replayed.

Signing out attempts to revoke the registration's renewable session, then removes local tokens. If remote revocation cannot be confirmed, the page tells you. To disconnect completely, go to **ChatGPT Settings → Security & login → Sign in with ChatGPT → DeepSeek Harness → Disconnect**. See [OpenAI's accounts and sessions documentation](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| DSH 0.2.1-rc.3 reports an incompatible plugin | Upgrade to **0.1.5-daybreak**, then quit and reopen DSH; see the compatibility explanation below |
| Continue with ChatGPT in Settings does nothing | Install a build containing the live management-address fix and restart DSH; Settings retries automatically and disables the button while the service is unavailable |
| No plugin settings | Confirm installation in the active DSH profile and that the plugin is enabled, then quit and reopen DSH |
| Signed in, but no models | Confirm plan permission, refresh models, and check eligibility and network settings |
| Browser sign-in works, but the plugin cannot connect | Check browser and plugin network settings separately |
| Sign-in page reports `Invalid Origin` | Upgrade to **0.1.5-daybreak**, restart DSH, and reopen the account management page; see below |
| Model unavailable after switching accounts | Select a model actually returned for the new account |
| Authorization expired | Sign in again; do not copy another app's token files |
| Credential permission error | Check current-user ownership, owner-only permissions, and that the file is not a symlink; never attach account files to an issue |
| Resuming a goal reports `objective and max_goal_rounds are valid only with action edit` | Upgrade to **0.1.5-daybreak** and restart DSH; see below |
| `stale goal ref` or `the model cannot resume a paused goal` | Check the goal revision and paused state as described below |

### Incompatible plugin on DSH 0.2.1-rc.3 (fixed in 0.1.4)

Version 0.1.3 pins `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-llm-pi-ai` to exactly `0.2.0-rc.2` in `peerDependencies`. DSH 0.2.1-rc.3 ships both packages at `0.2.1-rc.3`, so its compatibility check disables the older plugin. The host's `@earendil-works/pi-ai` has also moved from `0.87.1` to `1.1.0` and needs an updated declaration, but it does not participate in that DSH compatibility check.

Version 0.1.4 uses bounded ranges so each compatible update does not need its own exact version entry:

- Both DSH peers use `0.2.0-rc.2 || >=0.2.1-rc.3 <0.2.2-0`: retain the original version and allow 0.2.1 prereleases from rc.3 through the 0.2.1 stable release. Prerelease and stable versions of 0.2.2 or later are excluded.
- The pi-ai peer uses `0.87.1 || ~1.1.0`: retain the original version and allow 1.1.x patch releases. Version 1.2 and later are excluded.

Only DSH 0.2.1-rc.3 / pi-ai 1.1.0 was tested for this update. Later versions within the ranges are permitted but untested, and the older combination was not dynamically retested. Validation covers the host's native compatibility check, plugin initialization with a temporary profile and a mocked adapter registry, and adapter requests with mocked network responses. This is not a complete desktop end-to-end test; live account authorization and plan inference were not repeated.

Quit DSH completely, install the 0.1.5-daybreak `.tgz`, then reopen DSH. There is no need to modify host dependencies or account files.

Desktop caches page configuration at startup, so a plugin activated or reloaded later may lack a usable management address. Settings now retrieves the current address through DSH's authenticated same-origin endpoint on every status refresh, including when the management port changes. The old startup injection is retained only as a fallback when the endpoint does not exist. Until an address is available, Settings shows an explicit waiting state instead of a Continue with ChatGPT link without a destination.

<a id="sign-in-invalid-origin"></a>

### Invalid Origin on sign-in (fixed in 0.1.3)

The previous management page's `no-referrer` policy made browser login forms send `Origin: null`, which local origin validation rejected. Version 0.1.3 uses `same-origin` only for the management page; OAuth callbacks retain `no-referrer`, and origin and CSRF checks remain enforced. After upgrading and restarting DSH, reopen the account management page before signing in; do not reload the old `/oauth/start` error page.

### Images and error recovery (fixed in 0.1.2)

If reading an image leads to `Attachment reference is invalid.`, or the turn fails with `Cannot read properties of undefined (reading 'includes')`, upgrade to **0.1.5-daybreak**, quit and reopen DSH, then retry in the original conversation.

Earlier versions passed the path mapper and attachment reference to DSH's image-access helper in the wrong order, causing image-bearing requests to fail during local request construction. The plugin also supplied an incomplete retry policy, so error recovery threw a second exception that hid the original failure. Version 0.1.2 corrects the argument order and uses DSH's policy resolver to populate retry codes and backoff settings.

The fix covers user images and images returned by tools, including desktop screenshots read with `read_image`. A Kimi CU screenshot exposed the issue, but the failure was in this plugin's model adapter. The plugin does not install or manage Kimi CU; the selected model must still support image input.

### Goal recovery and tool argument errors

**0.1.1 fixes optional tool parameters being forced into calls.** In 0.1.0, the plugin configuration made pi-ai omit `strict` from tool definitions. The Responses API may then normalize optional parameters into required ones. For example, an `update_goal` call with `action: "resume"` could include the edit-only `max_goal_rounds` field and be rejected by DSH. Version 0.1.1 makes pi-ai explicitly send `strict: false`, preserving optional parameters. See [OpenAI's strict-mode documentation](https://developers.openai.com/api/docs/guides/function-calling#strict-mode).

Goal recovery also follows DSH's own state and permission rules:

- **`stale goal ref`**: the goal has changed, but the model is using an old `revision`. Read the current state with `get_goal` before deciding what to do next; do not retry the old revision. Operations such as pausing and resuming advance the revision. This error alone does not indicate expired credentials or corrupted data.
- **`the model cannot resume a paused goal`**: the user must click Resume in the goal interface or send **`/goal resume` by itself** in the original conversation. An ordinary chat message such as “continue” does not replace this command.
- **An `active` goal does not continue automatically after a restart**: it may be `disarmed`; use `/goal resume` to re-enable continuation. `max_goal_rounds` limits automatic continuation rounds, each of which can contain multiple tool calls.

These rules come from the [goal tools](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/goal/tool-goal/README.md) and [user commands](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/goal/command-goal/README.md) in the previously reviewed DSH 0.2.0-rc.2 source. The plugin preserves these state and permission checks.

## Data and authorization

Account data is stored in `data/dsh-chatgpt-plan/accounts.json` under the active DSH profile, with `network.json` beside it. On macOS, the desktop profile typically uses `~/.dsh/profiles/desktop/data/dsh-chatgpt-plan/`. Directory permissions are `0700`; file permissions are `0600`.

Credentials are in a local file, **not an encrypted vault**. Programs running as the same system user or with sufficient privileges may read them. Do not share account files, full authorization callback URLs, tokens, or logs containing them. Published source and packages contain no runtime account data.

The implementation uses dynamic registration, Authorization Code + PKCE, per-attempt state and nonce, and ID-token signature, issuer, audience, expiration, and identity checks. Credentials are written atomically, and refreshes are serialized with a file lock. The local management page checks Host, Origin, and CSRF; OAuth tokens are not sent to its frontend.

Models come from `https://api.openai.com/v1/models`; inference uses `https://api.openai.com/v1/responses` with `store:false` and `stream:true`. The plugin adapts local tool calls, does not use ChatGPT `backend-api`, and does not fall back to API-key billing. Other search or external services retain their existing DSH configuration. See [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) and [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

## Upgrade and uninstall

Quit DSH before installing a newer `.tgz` with the same installation command. Normal upgrades preserve account files within the same DSH profile. Reopen DSH and check the connection afterward.

Before uninstalling, sign out on the account page and select another provider as DSH's default model. Quit DSH, then run:

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop remove dsh-chatgpt-plan
```

Uninstalling does not itself disconnect the app at OpenAI. Follow the sign-out instructions above to revoke access completely.

## Relationship with DSH and pi-ai

**You do not need to install the Pi app separately.** This plugin reuses `@deepseek-ai/dsh-llm-pi-ai` and `@earendil-works/pi-ai` supplied by the DSH host. This update was tested with DSH **0.2.1-rc.3** and pi-ai **1.1.0**. The [peerDependencies](package.json) allow later 0.2.1 release candidates, the 0.2.1 stable release, and pi-ai 1.1.x patches, while retaining the previously supported DSH **0.2.0-rc.2** / pi-ai **0.87.1** combination. See the compatibility explanation above for the distinction between allowed and tested versions.

### Where DSH depends on pi-ai

In the DSH 0.2.0-rc.2 source reviewed here, direct use of pi-ai is concentrated in the [`@deepseek-ai/dsh-llm-pi-ai`](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84/packages/llm/llm-pi-ai/src) model adapter:

- **Provider and model catalogs, and authentication interfaces:** connects pi-ai's provider definitions, model capabilities, and authentication flows to DSH's configuration and credential management.
- **Request protocols and streaming:** uses pi-ai implementations such as OpenAI Responses, Chat Completions, and Anthropic Messages to send requests and process response events.
- **Conversion between DSH and pi-ai:** DSH's adapter code translates message context, tool definitions, stream events, usage, and replay metadata for DSH's model interface.

DSH continues to provide the agent loop, tool execution, file permissions, conversation storage, plugin system, and interface. Its [native DeepSeek adapter](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84/packages/llm/llm-deepseek) also has a separate implementation; the dependency described above is concentrated in model integration.

### What this plugin reuses

This plugin registers only the ChatGPT plan provider. DSH's overall use of pi-ai is broader than the parts this plugin calls directly.

| Implementation source | Role in this plugin |
| --- | --- |
| DSH's bundled `PiAiAdapter` | Connects the plugin's models and responses to DSH's model interface, reusing message, tool, and stream-event conversion |
| DSH's bundled `pi-ai/api/openai-responses` | Builds Responses requests and parses streamed responses through `stream` / `streamSimple` |
| This plugin | Independent ChatGPT authorization, account management, credential renewal, discovery of models available to the account, and adaptation of plan request parameters and local tool calls |

See [index.mjs](index.mjs) for imports and adapter registration, and [adapter.mjs](adapter.mjs) for request adaptation. The plugin implements ChatGPT sign-in in [oauth.mjs](oauth.mjs); it does not read Pi or Codex login files.

### How this relates to newer pi-ai versions

For comparison, [pi-ai 1.0.2 already includes a Sign in with ChatGPT implementation](https://github.com/earendil-works/pi/blob/v1.0.2/packages/ai/src/auth/oauth/openai-chatgpt.ts). This project targets the DSH / pi-ai combination verified here and packages ChatGPT plan access as a separately installable DSH plugin with an account-management interface.

That upstream capability does not establish that an older DSH release includes it, or that replacing the host's pi-ai with 1.x will remain compatible. Updating pi-ai elsewhere on the system or in another project does not update the dependency bundled in DSH. After upgrading DSH or changing dependencies, recheck plugin loading, authorization, model discovery, streaming replies, and tool calls.

See the [DSH community discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/8851) for discussion of extension interfaces suitable for long-term maintenance.

## Build from source and develop

Use Node.js 22 or later; this release was validated with Node.js 24. There is no compilation step:

```sh
git clone --branch v0.1.5-daybreak https://github.com/yeahx/dsh-chatgpt-plan.git
cd dsh-chatgpt-plan
npm test
npm pack --ignore-scripts
```

`npm test` uses Node's built-in runner and mocked responses. It needs no real account, internet connection, or installed DSH host dependencies. `npm pack` creates `dsh-chatgpt-plan-0.1.5-daybreak.tgz`; install it as described above. DSH resolves dependencies for actual runtime use during installation.

Tests cover account isolation, PKCE and identity validation, cancellation on switching, renewal and backoff, 401 retry, revocation, storage permissions, profile isolation, port conflicts, network settings, and management-page access control. On macOS with the compatible DSH version installed, also run the native compatibility check and adapter simulations:

```sh
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  scripts/compatibility-test.mjs
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  scripts/wire-test.mjs
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  scripts/image-wire-test.mjs
```

`compatibility-test.mjs` uses the host's native dependency check and verifies plugin initialization with a temporary profile and a mocked adapter registry; it does not start the full DSH desktop environment. `wire-test.mjs` and `image-wire-test.mjs` mock the network. The image test uses DSH's native attachment store, model adapter, and retry executor to cover user images, tool screenshots, invalid attachments, preservation of original errors, and the two-retry limit. The other test checks that requests emitted through DSH and pi-ai explicitly include `strict: false` and retain optional tool parameters, including after account switching and a 401 refresh retry. Passing simulations does not establish eligibility for every real account; actual use requires the account owner's authorization.

The browser sign-in regression requires Playwright to be importable from the current Node environment and a corresponding browser to be installed. For example, with Microsoft Edge installed:

```sh
PLAYWRIGHT_CHANNEL=msedge node scripts/management-browser-test.mjs
```

If Playwright is elsewhere, set `PLAYWRIGHT_MODULE` to its module entry's absolute path or `file:` URL. This real-browser test covers adding an account, signing in again, authorizing plan usage, and suppressing referrers after callbacks. It also uses temporary account storage to test saving inference choices, persistence after a server restart, isolation between two accounts, restoring defaults, and save failures. Authorization is mocked on loopback; it reads no real accounts and consumes no plan allowance.

## License and artwork

Code is licensed under the [MIT License](LICENSE). The unofficial icon includes an AI-generated DeepSeek girl and ChatGPT Token illustration. It does not imply publication, certification, or endorsement by DeepSeek or OpenAI. The code license does not grant rights to third-party brands or underlying character designs.
