# alfred-kbr：讀取端與 collie 寫入端搬離 kb（報告）

2026-09-26 · alfred-kbr · 兩個 commit：collie `261d06e5`（branch `alfred-kb`）、ai-stock `7ad40ab`（branch `alfred-kb`）。
沒有 push、merge、重啟服務，也沒有改 `~/.config`、`~/secrets`、`~/agentry-data`、LaunchAgents、cloudflared。

> **Caution.** 這份報告放在指定的 `docs/alfred-kbr-report.md`，但 `cli/docs-embed.test.ts`
> 規定 `docs/*.md` 每一頁都要嵌進 binary，所以只要這個檔案還在，那個測試就會失敗
> （`every page on disk is embedded`）。merge 前請把它移出 `docs/`（例如移到 repo 根目錄或 wiki），或直接刪掉。
> 功能 commit `261d06e5` 本身不會觸發這個問題。

## 1. 改了什麼

| 範圍 | 之前（kb） | 之後（agentry） | 位置 |
|---|---|---|---|
| Meow 單份文件 `/api/doc/<slug>` | 帶 `x-internal-token` 打 kb loopback API，共兩次請求 | `agentry query` 取得 `documents_latest` 的一列，再讀**那一列指定的** `<home>/documents/<html_path>`，經 `containedRealpath` 並核對 `html_sha256` | `bridge/docs.ts:466`（fetchDocument）、`:503`（containment）、`:524`（hash）、`:425`（SQL） |
| Meow 文件列表／搜尋／tag | kb 的 `/api/documents`、`/api/search`、`/api/tags` | 用 SQL 查 `documents_latest`：不列 draft；搜尋是 title／summary／slug／tags 的子字串比對；一個 tag 會連同子 tag 一起比對；計數會往父 tag 累加（等同 kb 的 `<@`） | `bridge/docs-list.ts:121`、`:139`、`:157`、`:190`、`:214` |
| SQL 字串 | —（kb 走 HTTP） | 一律經 `sqlText`，單引號加倍。`agentry query` 本身也只接受讀取語句 | `bridge/docs.ts:285` |
| 設定 | `COLLIE_KB_ORIGIN` + `COLLIE_KB_TOKEN` | `COLLIE_AGENTRY_HOME`（沒設就整個功能關閉）、`COLLIE_AGENTRY_CLI`（預設 `~/.local/bin/agentry`） | `bridge/config.ts:190-196`、`:686-687`；`bridge/config-schema.ts:743-761` |
| `/api/config` 的 `docHosts` | kb 的 origin 和 token 都設了才發布 | 設了 agentry home（且是絕對路徑）才發布 | `bridge/server.ts:1199`、`:3148` |
| 手機上的連結分類 | 只認 `https://<host>/d/<slug>` | `/d/<slug>` 和 `/doc/<slug>` 都認，而且在每個已設定的 host 上都有效。fallback host 清單補上 `alfred.agnex.dev` | `web/src/lib/doc-links.ts:111`、`:122`、`:285` |
| artifact 檢視頁的按鈕 | 顯示「kb」 | 顯示「Alfred」（仍然用同源、`sandbox=""` 的 `/api/doc/<slug>` 開啟） | `web/src/routes/artifact.tsx:195` |
| `collie artifact promote` | 呼叫 kb CLI 的 `push` 和 `promote` 兩步 | 只呼叫一次 `agentry doc push <file> --slug --title --source report --folder [--summary] [--tag]… [--home] --format json`，印出 `https://alfred.agnex.dev/doc/<slug>`，slug 寫回 `kbSlug` 欄位（欄位名稱不改，省掉 migration）。新增 `--slug`，`--kb-slug` 仍可用 | `cli/artifact.ts:257`、`:341`、`:346`、`:374` |
| 子程序 runner | — | `runQuotaCommand` 新增可選參數 `cap`，查詢時共用它的 spawn 規範 | `bridge/quota.ts:70` |
| finance-mcp `finance_knowledge_*` | httpx 打 kb 8082，引用連結是 `knowledge.simcoe-project.com/d/` | `knowledge_system` provider 改讀 agentry documents（provider 名稱不變，因為它是工具契約的一部分），引用連結改成 `https://alfred.agnex.dev/doc/<slug>` | `tools/finance-mcp/finance_mcp/providers/knowledge_system.py:44`、`:71`、`:184`、`:287` |
| finance-mcp related | lineage 加上 similar（embedding 全是 NULL） | **乾淨降級**：slug 在允許範圍內就回 `[]`，否則回 `NOT_FOUND` | `knowledge_system.py:156` |
| finance-mcp 啟動 | 檢查 folder 和 tag 是否存在，不存在就 fail closed | 只檢查 agentry 能不能回應。agentry 沒有 folder／tag 的註冊表，而 `invest` 目前沒有任何文件 | `knowledge_system.py:118` |
| finance-mcp 設定 | 必填 `FINANCE_MCP_KNOWLEDGE_TOKEN_FILE`，另有 `…_KNOWLEDGE_SYSTEM_URL` | `FINANCE_MCP_AGENTRY_HOME`、`FINANCE_MCP_AGENTRY_CLI`（有預設值，必須是絕對路徑）。上面兩個舊變數移除 | `settings.py:10-11`、`:130` |
| ai-stock 規範 | 寫的是「走 knowledge-system」 | 改成 `agentry doc push`／Alfred | `CLAUDE.md:57`、`:143`、`CONVENTIONS.md:160` |

Alfred 為什麼不能直接問：它的每個請求（包含 loopback）都要驗證 Cloudflare Access JWT（`agentry/src/web/server.rs` 裡的 `AccessGate`）。
所以 bridge 改讀 agentry 自己的資料，不經過 Alfred。

面板的 `sandbox` 和 `DOCUMENT_CSP` 都沒動。ETag 的格式 `"d1:<sha>"` 也沒動，而且匯入時是逐位元組複製，所以手機上舊的快取還是有效。

## 2. 測試與 vacuity check

| 套件 | 結果 |
|---|---|
| collie `bun test` bridge（排除 crew/harness） | 3958 pass、4 fail。其中 shot、changes、pi 三個在 `dce57e59`（未改動的 HEAD）上也一樣失敗；pairing 是負載下的計時 flake，單獨跑會過 |
| collie `bun test ./cli` | 1632 pass、2 fail（`collie --version`／`-V`），在 HEAD 上一樣失敗 |
| collie `bun test ./scripts` | 114 pass、0 fail |
| collie web `bun run test` | 9681 pass、1 fail（`changes.test.tsx`，全套一起跑時會 flaky；單獨跑，以及和 doc-links、doc-panel、agent-chat 一起跑，216 個全過） |
| 兩邊的 typecheck | 綠 |
| `bun run lint` | 只剩一個錯誤：`web/src/test/setup.ts:92`，來自 `dce57e59` 的 merge，不是這次造成的 |
| ai-stock `pytest tools/finance-mcp/tests` | 371 passed（原本 355），ruff clean |

**Vacuity check**：每一項都是故意把修正拿掉，確認測試變紅，再還原。還原後全部回到綠。

| 拿掉的修正 | 紅的數量 |
|---|---|
| collie：containment 檢查 | 3 |
| collie：hash 檢查 | 1 |
| collie：`sqlText` 的單引號加倍 | 2 |
| collie：304 提前返回 | 1 |
| collie：fatal UTF-8 | 1 |
| collie：絕對路徑檢查 | 3 |
| collie：draft 過濾 | 1 |
| collie：tag 往父層累加 | 1 |
| collie：tag 子層比對 | 1 |
| collie web：`/doc/` 前綴 | 2 |
| collie web：`alfred.agnex.dev` 預設 host | 1 |
| collie promote：`doc push` 動詞 | 3 |
| collie promote：Alfred origin | 1 |
| collie promote：`/doc/` 路徑 | 2 |
| collie promote：`--home` | 1 |
| finance-mcp：containment | 2 |
| finance-mcp：舊的 kb 引用網址 | 2 |
| finance-mcp：hash | 1 |
| finance-mcp：related 的存在檢查 | 1 |
| finance-mcp：draft 過濾 | 1 |
| finance-mcp：絕對路徑 | 2 |
| finance-mcp：本文搜尋 | 1 |

**對真實 agentry 的唯讀 smoke test**

- collie：
  - 能讀到 `tradingview-mcp-official-vs-github`、`medium-digest-2026-09-26`（1.1 MB）、draft `atomic-note-writing-style`，三份的 304 都正確。
  - 不存在的 slug 回 `not_found`。列表約 104 ms。
  - 含引號的搜尋、中文搜尋「架構」都正常。
  - tag 共 57 個，`database` 會把子 tag 一起算進去。
  - 搜尋結果不含 draft。
- finance-mcp：
  - 預設 manifest 回空。
  - 改用 `ai ∩ market_cockpit` 時有 4 筆，引用連結是 `alfred.agnex.dev/doc/…`。
  - `get` 會截斷。
  - 不在允許範圍的 slug 回 `NOT_FOUND`。
  - binary 不存在時回 `KNOWLEDGE_SOURCE_UNAVAILABLE`。

`bun run build` 沒有跑：它會把 artifact 換進這個 worktree。兩邊的 typecheck 已經涵蓋編譯。

## 3. Integrator 要做的部署步驟

1. **修改 `~/.config/collie/.env`**：

   | 動作 | 行 |
   |---|---|
   | 刪除 | `COLLIE_KB_ORIGIN=…`（盤點記錄的第 41 行）、`COLLIE_KB_TOKEN=…`（盤點記錄的第 42 行），以及 `COLLIE_KB_CLI`／`COLLIE_KB_PUBLIC_ORIGIN`（如果有） |
   | 新增 | `COLLIE_AGENTRY_HOME=/Users/peiyuhsieh/agentry-data`（這一行決定面板開不開） |
   | 可選 | `COLLIE_AGENTRY_CLI=/Users/peiyuhsieh/.local/bin/agentry`（預設值就是這個） |
   | 可選 | `COLLIE_AGENTRY_PUBLIC_ORIGIN=https://alfred.agnex.dev`（預設值就是這個） |
   | 修改 | `COLLIE_DOC_HOSTS=knowledge.agnex.dev,alfred.agnex.dev`（盤點記錄的第 45 行，目前只有 knowledge） |

   舊的 `COLLIE_KB_*` 留著不會出錯，只是不再被讀取。
2. 部署 collie：把 `261d06e5` merge 進 fork 的 `main` → `bash scripts/collie-ctl.sh build` → `./bin/collie restart`（或 `herdr plugin action invoke restart --plugin herdr.collie`）。bridge 有改，所以一定要重啟。
3. 驗證 collie：
   - `curl -s http://127.0.0.1:4318/api/config` 的 `docHosts` 要包含 alfred。
   - 在手機上點一個 `alfred.agnex.dev/doc/<slug>` 連結，要在面板裡打開。
   - 文件瀏覽器的列表和 tag 都要出現。
4. 部署 finance-mcp：把 `7ad40ab` merge 進 ai-stock，照 `tools/finance-mcp/README.md` 的 canonical checkout 流程重新部署並重啟。
   - `~/secrets/finance-mcp/runtime.env:2` 的 `FINANCE_MCP_KNOWLEDGE_TOKEN_FILE` 可以刪；留著也不會被讀。
   - 如果 `agentry-data` 或 binary 不在預設位置，要加 `FINANCE_MCP_AGENTRY_HOME`、`FINANCE_MCP_AGENTRY_CLI`。
5. 驗證 finance-mcp：啟動 log 不應出現 kb 連線錯誤；`finance_knowledge_search` 的 `failed_providers` 不應包含 `knowledge_system`。

## 4. 未解問題

- **finance-mcp 的 manifest 實際上一直是空的**：`folders: [invest]` 和 `tags: [market_cockpit]` 取交集是 0 筆，kb 時代也是 0 筆。5 份 `market_cockpit` 文件在 `ai`（4 份）和 `side-projects`（1 份）。要不要放寬（例如改成 `folders: [ai]`）是隱私決策，因為 finance-mcp 對外開放，所以沒有改。
- finance-mcp 的搜尋會讀允許範圍內每份文件的 HTML 本文。允許範圍最多 50 份，而且有依 sha 的快取。如果放寬 manifest，包含 1 MB 等級的 medium-digest，第一次搜尋會比較慢。
- collie 的搜尋只比對 metadata（title、summary、slug、tags），不搜本文。kb 以前搜的是 chunk 全文。agentry 沒有全文索引。
- 除了 finance-mcp 的 README 以外，collie 的 `docs/` 和 upstream 文件沒有提到 `COLLIE_KB_*`。這組設定只記在 `FORK.md` 和 `CHANGELOG.fork.md`（後者已加上一節）。
- 這次沒有處理的其他 kb 使用者（`kb-inventory.md` §2）：
  - medium-digest skill
  - kb-upload／html-presentation skill（看起來已由別的 worker 改過）
  - `agentry/runtime/CLAUDE.md`
  - wiki 裡的 20 個 `/d/` 連結
  - 轉址與關機步驟
- 既有的測試失敗（shot、changes、pi、`collie --version`）和 lint 錯誤（`web/src/test/setup.ts:92`）來自 `dce57e59`，不在這次範圍內。
