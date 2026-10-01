# Совместная работа — приватный пакет 1.0.0

The package binds the existing FullaccessbdYCS MCP connection through root `.app.json` and `extensions.com.openai.apps`. Roman supplied its card URL on 2026-10-01: https://chatgpt.com/plugins/plugin_asdk_app_6ab62464139481918693c44785d8ca68?view=personal. The app manifest uses the registered app ID `asdk_app_6ab62464139481918693c44785d8ca68`; `plugin_` is the card's plugin prefix. Plugin Creator metadata confirms that the supplied card is app-backed and cannot be edited with its package editor. This package references that integration and does not alter it.

Private account-save status and exact plugin/release IDs are recorded in `workspace/docs/TASK_STATE.md`. A package save is not an installation, refreshed connection, or UI-test result. Preserve existing host-managed authentication; no endpoint login credentials belong in this package.

Server source: rtalyutin/Tg-mcp PR33, merged revision7aca0136ab815bb15490ad83844020cf7e490a50. Runtime1.0.3 digestf4217e045c20d2f968391391917e8c5b6a8de38232c21ca005461f0cc273d08c confirmed through existing authenticated MCP after release. UI1.0.0 resourceui://workspace/projects-v1.html, openerworkspace_open_projects. Preserve the existing MCP authentication and private audience.

No skill packages or additional connectors are bundled at this stage. Actual UI opening in ChatGPT web/desktop belongs to Roman under the current contract.
