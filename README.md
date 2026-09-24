# 目讀 · Gaze Reader

繁體中文介面的英文閱讀工具：匯入文章，以滑鼠或經校準的 webcam 選字，放大閱讀、查看中文翻譯、聽英文發音，並將生字收進 Flash Card 溫習。

[開啟網頁版](https://xiaoyh-code.github.io/eyetracingreading/) · [原始碼](https://github.com/xiaoyh-code/eyetracingreading)

網頁版由 GitHub Pages 提供靜態檔案，無需登入或安裝 Python。也可在自己的電腦啟動本機版。兩者的雲端生圖均使用你在網頁輸入的**本次分頁密鑰**，沒有共用作者的 API Key，亦沒有代為保管密鑰的伺服器。

## 第一次使用

1. 開啟示範文章，將滑鼠停在英文單字上，或直接點選單字。
2. 拖入 PDF、Markdown、TXT 或 DOCX；亦可貼上英文文字。
3. 調整字體、行距和停留時間。示範翻譯及小型詞庫可直接使用；一般英中翻譯需先按「啟用離線翻譯」。
4. 點喇叭播放英文發音；按「加入生字與溫習卡」收藏單字。
5. 想以視線選字時，選擇鏡頭模式、授予相機權限，完成校準及驗證。
6. 生圖是額外選項：在「API 設定」輸入自己的 TokenHub Key，明確按生圖按鈕才會發出雲端請求。

建議使用更新的桌面 Chrome 或 Edge。相機需要 HTTPS 或 localhost；請勿直接以 `file://` 開啟 HTML。

## 文件與閱讀

| 格式 | 處理方式與限制 |
| --- | --- |
| PDF | 擷取可選取文字並重排；不保留原始版面，不包含 OCR |
| Markdown | 擷取可讀文字，不執行匯入的 HTML 或程式碼 |
| TXT／貼上文字 | 依段落、句子及單字排版；文字檔支援 UTF-8／UTF-16 |
| DOCX | 擷取正文及表格文字；圖片、文字方塊、頁眉頁腳可能不保留 |

網頁版在瀏覽器內解析文件，不把整份文稿上傳到 GitHub 或翻譯供應商。每個檔案上限 20 MB，文字上限 150,000 字元；瀏覽器 PDF 解析另設 300 頁上限。掃描 PDF 需先自行 OCR；加密文件需先解鎖；舊式 `.doc`／RTF 請先轉成 DOCX 或 TXT。多欄 PDF、表格和公式的閱讀順序可能需要人工校正。

閱讀器只追蹤匯入此頁面的文章，不會讀取其他應用程式或整個螢幕。停留時間和重讀次數只是可調整的提示訊號，不能判斷讀者是否真正理解文字。

## 離線翻譯

未下載模型時，示範文章的人手句譯及小型詞庫仍然可用；未收錄的內容會清楚提示。按「啟用離線翻譯」後，瀏覽器才會下載英中模型及執行資源，首次合共約 150 MB，實際大小視快取及版本而定。

模型採用 OPUS-MT，透過 Transformers.js／WebAssembly 在瀏覽器的 Worker 內執行，並轉換成繁體中文。下載模型需要網絡，翻譯時所選文字不會傳到模型託管服務。一般單字及短句可以翻譯，但它不是通用詞典或大型語言模型，不會自動創作例句；多義詞需結合整句判斷。瀏覽器每次翻譯接受最長 80 字元的單字及 1,200 字元的句子，另有模型 token 上限。

模型會由瀏覽器快取，快取可能因清除網站資料、私密模式或儲存空間不足而消失。重新開頁需要再次初始化模型，有完整快取時可重用下載。網站亦會快取公開程式資源，但未使用過的功能可能尚未下載完整；**模型可離線運算，不代表 GitHub Pages 網站保證能在斷網後重新開啟**。需要穩定離線使用時，請用下方本機版。

本機版亦可另裝 Python 翻譯模型，使用 CTranslate2／OpenCC 在 CPU 上運行：

```bash
uv run python scripts/prepare_offline.py
```

這是一次約 71 MB 的模型下載，存於 `.models/en-zh`，不會提交至 Git。可用環境變數 `READER_MODEL_DIR` 指定其他位置。本機模型未安裝時，仍可使用瀏覽器翻譯選項及內置詞庫。

## TokenHub 單字生圖：只用本次密鑰

目前網頁介面支援騰訊 TokenHub 的 `hy-image-v3` 圖片模型。OpenAI、舊式騰訊雲 SecretId／SecretKey 及雲端語音均未在此網頁版啟用。

在「API 設定」貼上你自己的 TokenHub API Key，選擇與帳戶一致的官方服務地區，再連接本次分頁。連接只更新記憶體狀態，**不驗證帳戶、不發出試用生圖、不產生測試費用**。選字後明確按生圖按鈕，才會將該字、所在句子及插畫描述直接送到所選的 TokenHub 官方 HTTPS 接口。每次要求一張 1024 × 1024 圖片，可能產生供應商費用。

- 密鑰只存在目前分頁的 JavaScript 記憶體；不寫入 localStorage、sessionStorage、IndexedDB、Cookie、`.env`、GitHub 或 Python 後端。
- 重新整理、離開／關閉頁面或按「斷開連線」會清空密鑰；瀏覽器恢復先前頁面時亦需重新連接。
- 使用同步接口 `/v1/wand/hunyuan-image/v3-generation`，僅允許列入程式清單的騰訊官方 HTTPS 網址。
- 請求不會自動重試。結果不明、逾時或中斷後，同一分頁對同地區、同字句設一小時防重複提交記錄；斷開或重開頁面會清除此記錄。供應商已接收的工作不一定能取消，重試前請先查看控制台，避免重複收費。
- 成功結果只在本次分頁快取。圖片由供應商的結果網址載入，連結可能到期；不包含永久圖片收藏服務。

帳戶需要有效密鑰、對應地區及圖片模型權限／額度。瀏覽器直連亦取決於 TokenHub 是否允許該網站來源的跨域請求（CORS）；如果供應商拒絕，程式會提示失敗，不會改用共用密鑰或代理轉送。測試使用模擬回應，未用訪客密鑰執行付費驗證；不能因此保證每個帳戶／地區均可生圖。

供應商接收的密鑰、字句及生成內容依其政策處理；「本網站不保存」不代表供應商也不保存。請只在信任的網站及瀏覽器環境輸入密鑰；網頁程式、遭入侵的相依資源或具有相應權限的瀏覽器擴充套件仍可能取得當次密鑰。建議使用限額、最小權限及可撤銷的專用 Key。

鏡頭使用鎖定版本 WebGazer 3.5.3，其 MediaPipe／Emscripten 執行器需要動態產生 JavaScript。因此 CSP 的 `script-src` 保留 `'self'`、`'wasm-unsafe-eval'`，並明確允許 `'unsafe-eval'`；沒有允許外部來源或行內腳本。這項相容性取捨適用整個頁面，不能只限於鏡頭套件，亦會減少 CSP 對程式碼注入的防護。程式不把匯入文件當成 HTML 執行，依賴以版本及完整性鎖定；這些措施不代表當次 API Key 可以抵抗所有 XSS 或相依套件入侵。

官方參考：[TokenHub API 文件](https://cloud.tencent.com/document/product/1823/130078)、[Hy 圖片生成接口](https://cloud.tencent.com/document/product/1823/135745)。

## Webcam 視線追蹤

鏡頭模式使用 [WebGazer](https://webgazer.cs.brown.edu/)，在瀏覽器內處理鏡頭影像。相機只在你啟動此模式並授權後開啟，退出時釋放；應用程式不會上傳或保存鏡頭畫面。完成九點校準及驗證後，再開始閱讀。

驗證會顯示像素誤差。一般 webcam 未必能分辨細小相鄰單字；請保持均勻光線、相對固定的臉部位置，並適度放大正文。移動頭部、改變視窗大小或環境後應重新校準。平滑及字詞吸附只能減少跳動，不能消除鏡頭本身的估計誤差；滑鼠可隨時作為精確選字的後備。未接駁 Tobii 等專用眼動儀。

橙色視線游標會吸附到文章字詞附近的固定位置，並使用對應單字觸發放大及停留提示。可以關閉游標顯示；這不會停用文章追蹤。失去鏡頭訊號、暫停、切換分頁或重新校準時，停留計時中止。開啟學習簿及溫習卡時也會暫停文章追蹤。

這是網頁內的閱讀提示，不控制作業系統滑鼠，也不會自動點擊按鈕。

## 英文發音

單字旁、詞義區及溫習卡有喇叭按鈕；按一次播放，再按同一按鈕停止。注視不會自動播音，播放亦不影響溫習評分。

網頁版只使用瀏覽器明確標示為本機的英文聲音，需要作業系統已安裝相應語音。找不到本機聲音時會提示，不會改呼叫雲端 TTS。本機 Python 版在 macOS 可額外使用已安裝的英文聲音生成 WAV，再於頁面播放；此後備只經 localhost，GitHub Pages 無法呼叫你的 macOS 系統語音服務。

## 學習簿與 Flash Card

收藏單字後，卡片會包含英文、原句、中文詞義、翻譯及文章來源。頂部「溫習卡」可開始到期溫習；「學習簿」可查看、刪除、匯出及匯入生字。

- **未記熟**：10 分鐘後再次到期，重設連續記得次數。
- **記得**：依連續記得次數，在 1、3、7、14、30、60、90 日後重溫，最長為 90 日。
- 預設只練新字及已到期卡片；「全部練習」亦會依評分更新下次溫習時間。
- 空白鍵翻面，`1` 選未記熟，`2` 選記得，`Esc` 返回閱讀。

收藏、評分及偏好保存在目前瀏覽器，按網站部署路徑區分；網頁版、localhost、不同瀏覽器或裝置不會自動同步。清除網站資料可能刪除它們。換裝置前請匯出 JSON 備份；JSON 包含溫習排程，CSV 供一般表格閱讀。

JSON 匯入會合併生字，保留已有同字的內容及進度，不會覆蓋；上限 10,000 個生字。匯出檔可能包含你收藏的原文句子，請自行保管。移除生字會同時移除該卡片。

## 資料會去邊度？

| 資料 | 位置／接收方 |
| --- | --- |
| 閱讀文章及解析結果 | 網頁版在瀏覽器記憶體；原文不會因閱讀或離線翻譯而上傳 |
| 相機影像及視線估計 | 瀏覽器內處理；不提交到伺服器 |
| 收藏、溫習排程及偏好 | 瀏覽器網站儲存；可匯出及刪除 |
| API Key | 當次分頁記憶體；生圖時直接送往你選定的 TokenHub 官方接口 |
| 生圖單字、例句與提示 | 只有明確生圖時送到 TokenHub；供應商按其政策處理 |
| 網站／模型下載 | GitHub Pages 及模型託管服務可收到正常網絡請求資料，例如 IP；模型下載不包含閱讀文章 |

網站沒有帳戶系統、作者雲端 Key、密鑰代理或跨裝置收藏同步。Python 本機服務只監聽 `127.0.0.1`，保留文件及離線輔助功能，不用來託管多用戶雲端 API。舊版 `/api/settings/tokenhub` 密鑰儲存接口已停用；本機服務不會載入 `.env`，亦不會把環境變數內的雲端密鑰作為後備。

## 在自己電腦運行

需要 Node.js 22.13 或更新版本／npm、Python 3.11–3.13 和 [uv](https://docs.astral.sh/uv/)；建議 Python 3.12。在專案根目錄執行：

```bash
npm ci --ignore-scripts
npm run build
uv sync --python 3.12
uv run python -m reader --open
```

建置會準備前端資源，輸出 GitHub Pages 用的 `dist/` 及本機用的 `reader/static/bundled/`。首次安裝及每次建置均需要網絡（建置時重新下載並驗證固定版本 WebGazer）；下載的依賴、模型和建置產物不提交至 Git。開啟 `http://127.0.0.1:8765`，按 `Ctrl+C` 停止。macOS 安裝及建置後亦可使用 `launch.command`；其他連接埠可用 `uv run python -m reader --port 8766 --open`。

本機翻譯是選配，安裝指令見上方。Webcam 程式及模型由建置流程準備；不使用鏡頭時可用滑鼠閱讀。每次前端原始碼更新後請重新執行 `npm run build`。

## GitHub Pages 部署與開發

Repository 的 GitHub Actions 工作流程會安裝鎖定的 npm 依賴、建置靜態網站，並把 `dist/` 作為 Pages artifact 部署。Pages 網站不需要 Python 伺服器或任何 API Key secret；不要在 Actions、前端環境變數或建置程式中加入使用者密鑰。

自行 fork 部署時，在 GitHub repository 的 **Settings → Pages → Build and deployment** 選擇 **GitHub Actions**，並確認工作流程有 Pages 部署權限。部署網址及存取範圍由你的 GitHub Pages 設定決定；不要以私人 repository 推斷網站也一定私人。

```bash
npm ci --ignore-scripts
npm test
npm run build
uv sync --python 3.12
uv run python -m pytest
uv run ruff check reader tests scripts
```

測試使用合成文件及模擬供應商回應，涵蓋解析限制、翻譯工作排程、密鑰生命週期、付費請求邊界、視線追蹤和 Flash Card。真實 webcam 精度仍需在你的設備驗證；測試不會替你開相機或使用付費 Key。

主要程式位置：

```text
reader/static/          共用閱讀介面、文件解析、視線、翻譯 Worker、分頁密鑰
reader/app.py           本機 FastAPI：離線功能、文件解析、macOS 發音
reader/offline.py       可選 Python 英中翻譯
reader/speech.py        macOS 本機英文語音後備
scripts/build-web.mjs   產生 Pages／本機前端資源
scripts/prepare_offline.py  可選 Python 翻譯模型安裝
tests/                 Python 與 JavaScript 測試
```

舊雲端 Python provider 模組僅保留作獨立程式庫及模擬測試，網頁後端不啟用，沒有由舊環境設定自動轉送請求的路徑。

## 授權

本專案使用 **GNU GPL v3 或更新版本（GPL-3.0-or-later）**；詳見 [LICENSE](LICENSE)。第三方套件、WebGazer 及其模型、OPUS-MT 翻譯模型分別依各自授權提供，來源及署名見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。依賴版本記錄於 `package-lock.json` 及 `uv.lock`。
