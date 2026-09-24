# 目讀 · Gaze Reader

在自己電腦運行的 Python 英文閱讀器。匯入文章後，用滑鼠或經校準的 webcam 選取閱讀位置；文字放大、停留及重讀提示會幫你找出想進一步理解的地方。介面使用繁體中文。

## 私人程式庫與部署

此專案可存放在私人 GitHub repository，下載到自己的電腦運行。API Key、`.env`、本機模型、瀏覽器測試產物及安裝的依賴不包含在程式庫；新電腦需要按下方步驟安裝資源並重新設定 Key。學習簿儲存在原本的瀏覽器，請先匯出 JSON 備份。

目前不是可直接部署到 GitHub Pages 的靜態網站：文件解析、本機翻譯、密鑰設定及圖片 API 都由 Python 伺服器處理；macOS 語音後備也在本機生成。GitHub Pages [只提供靜態網站託管](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)，不能執行這些後端功能。

私人 repository 也不會自動令 Pages 網站私人；[私人 Pages 存取控制](https://docs.github.com/en/enterprise-cloud@latest/pages/getting-started-with-github-pages/changing-the-visibility-of-your-github-pages-site) 需要 GitHub Enterprise Cloud 組織。若要從外面登入使用完整功能，需另外部署支援 Python、HTTPS 和使用者驗證的服務；目前伺服器只接受 localhost，未開放外網。

## 開始使用

需要 Python 3.11–3.13；建議用 Python 3.12，以及 Chrome／Edge。以下指令在本資料夾執行。

```bash
uv sync --python 3.12
uv run python scripts/prepare_offline.py
uv run python scripts/prepare_webgazer.py
uv run python -m reader --open
```

兩個安裝腳本各需一次網絡下載：翻譯模型約 71 MB；鏡頭程式和模型安裝後約 18 MB。安裝後閱讀、鏡頭追蹤和英中翻譯均可離線進行。本次工作環境已安裝好兩組資源。

瀏覽器開啟 <http://127.0.0.1:8765>。macOS 亦可雙擊 `launch.command`。按 `Ctrl+C` 停止伺服器。其他連接埠可用 `uv run python -m reader --port 8766 --open`。

沒有 uv 時：

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
python scripts/prepare_offline.py
python scripts/prepare_webgazer.py
python -m reader --open
```

### 第一次體驗

1. 預設開啟示範文章；滑鼠停在英文單字上，放大鏡會跟隨該字。
2. 停留達到設定時間，右側顯示詞義與句子解釋。點擊單字亦可直接查閱。
3. 回到曾讀過的句子達到設定次數，會提示重讀；移過同一句內不同字不算重讀。
4. 拖入 PDF、Markdown、TXT 或 DOCX；亦可直接貼上英文文字。
5. 調節字體、行距和停留時間；按「加入生字與溫習卡」收藏不熟悉的單字。
6. 按頁頂「溫習卡」，翻卡溫習；「學習簿」可匯出收藏。

## Flash Card 生字溫習

收藏的單字會自動成為溫習卡，之前已收藏的生字亦適用。卡片正面顯示英文單字、原句及文章來源；按「翻面睇解釋」查看中文詞義、句子翻譯，以及收藏時已有的例句和聯想提示。

- **未記熟**：10 分鐘後再次到期，重設連續記得次數。
- **記得**：依連續記得次數，在 1、3、7、14、30、60、90 日後安排重溫，最長為 90 日。
- 預設只溫習新字和已到期卡片；亦可在「我的生字」選「全部練習」。提早練習的評分同樣會更新下次溫習時間。
- 空白鍵翻面，`1` 選未記熟，`2` 選記得；`Esc` 返回閱讀。開啟溫習卡時暫停文章追蹤，關閉後恢復原本的暫停狀態。

每次評分即時儲存在目前瀏覽器，關閉後再開仍保留進度。溫習不需要 API 或網絡服務；清除瀏覽器資料會同時刪除卡片及進度。JSON 匯出包含溫習排程，CSV 保留原有詞庫欄位；目前沒有匯入備份的介面。移除生字會一併移除該卡片。

**學習簿入口**：頁面頂部「學習簿」或左邊「打開學習簿」。在文章點選單字，再按解釋區「加入生字與溫習卡」，便會收進學習簿。頂部「溫習卡」及左邊「溫習 Flash Card」可直接開始到期溫習。

## Webcam 眼球追蹤

先下載一次追蹤程式和模型到本機（滑鼠模式不需要）：

```bash
uv run python scripts/prepare_webgazer.py
```

在閱讀器選擇鏡頭模式，允許相機，依畫面完成九點校準和驗證。保持光線均勻、臉部位置固定。相機只會在你啟動鏡頭模式時開啟，退出鏡頭模式即釋放。

Webcam 模式屬實驗性質。驗證提供像素誤差，不能保證細小相鄰單字的準確度；建議放大正文。頭部位置、視窗尺寸或環境改變後應重新校準。滑鼠模式可精確選字，也可隨時作為後備。程式目前未接駁 Tobii 等專用硬件。

WebGazer 及其模型在上述安裝後由本機提供；影像處理在瀏覽器內進行，應用程式不會上傳或儲存鏡頭畫面。相機訊號消失、切換到其他分頁或暫停時，停留計時會中止。

### 網頁內視線游標

鏡頭校準完成後，橙色細游標會吸附到文章的字詞間隙（以及每行的頭尾），保持固定座標，避免逐像素跳動。視線穩定移到另一個位置約 100 ms 才切換，細微來回偏移會保留目前字縫。左邊「顯示視線游標」可開關顯示，選擇會保留在本瀏覽器。

游標會記住吸附位置對應的單字，放大和停留解釋使用該字；尚未確認的新視線不累積舊字的停留時間。關閉游標顯示不會改變文章追蹤。視線移出文章文字附近、鏡頭訊號超過約半秒沒有更新、切換分頁、暫停或重新校準時，游標會隱藏。開啟生字簿或溫習卡時也隱藏，文章自動解釋暫停。捲動、字體或版面改變會重新計算字縫。

此游標只顯示閱讀器網頁內的位置，不會移動作業系統滑鼠或自動點擊按鈕。平滑可以減少跳動，但不會改善鏡頭本身的校準誤差；實際精度仍以你的設備與校準結果為準。

### 英文發音

指向或點選單字，旁邊會出現喇叭按鈕；右邊詞義及溫習卡的單字旁亦可播放。按一次播放，再按同一按鈕停止；不會因注視自動播放，也不會改變卡片評分。浮動按鈕不佔文章排版空間。

預設只使用本機聲音：優先選擇瀏覽器明確標示為本機的英文語音；瀏覽器沒有可用聲音時，macOS 伺服器使用已安裝的英文聲音生成 WAV，再在頁面播放。只把所選單字傳給 localhost，不需 TokenHub key 或網絡生圖服務。其他作業系統需要瀏覽器可用的本機英文聲音；未找到聲音會顯示提示。

TokenHub 本身另有 [MiniMax TTS 接口](https://cloud.tencent.com/document/product/1823/135796)，支援 [英文合成](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)；這與 `hy-image-v3` 生圖模型是不同服務。可使用有對應權限的 TokenHub key，但須先開通語音模型。本工具目前未接駁或呼叫這項雲端 TTS，保留離線發音。

## 中文解釋及單字圖片

**預設離線優先，不需要 API key。** 安裝翻譯模型後，任意英文單字及句子可在 CPU 上翻譯成繁體中文。翻譯採用 Argos／OPUS-MT 英中模型、CTranslate2 與 OpenCC；單字譯名未必能處理所有多義情況，請結合整句理解。示範文章的人手句譯及小型詞庫會優先使用。

本機模型只做翻譯，未能提供通用的詞典式詳細解釋或自動創作例句。若未安裝模型，只可使用示範翻譯及內置詞庫。模型在 `.models/en-zh`；如搬到其他位置，可用 `READER_MODEL_DIR` 設定。

### TokenHub 混元生圖（目前選用）

TokenHub 使用單一 API key，與下方舊式騰訊雲 `SecretId`／`SecretKey` 接口分開。閱讀、翻譯與 Flash Card 繼續在本機運行；只有按「用 TokenHub 混元畫張圖」時，才把所選單字及例句送到騰訊 TokenHub。無需 OpenAI key 或開啟雲端文字助手。

**在網頁設定**：左邊「API 設定」→ 貼上 TokenHub API Key → 選擇與帳戶一致的服務地區 →「儲存設定」。設定即時生效，無需重啟服務；留空儲存會保留目前的 Key。儲存只更新本機設定，不會驗證遠端權限或發出生圖請求，亦不改變本機英文發音。

密鑰寫入專案根目錄的 `.env`，檔案權限為僅目前使用者讀寫，並被 Git 忽略；不寫入瀏覽器 localStorage、不在回應中返回密鑰。關閉設定或提交後輸入框會清空。若圖片仍在生成，需待任務結束才可更改設定；更改 Key 不會清除目前程序的重複請求保護。若啟動時另有手動匯出的環境變數，重新啟動仍會以該環境變數為優先；一般用 `launch.command` 啟動會讀取專案 `.env`。

亦可手動設定：

在本機 `.env` 設定：

```dotenv
IMAGE_PROVIDER=tokenhub
TOKENHUB_API_KEY=你的TokenHub_API_Key
TOKENHUB_BASE_URL=https://tokenhub.tencentmaas.com/v1
TOKENHUB_IMAGE_MODEL=hy-image-v3
```

重新啟動 Python 服務，再重新整理閱讀器。`TOKENHUB_BASE_URL` 需與帳戶開通的站點及地域相符：上例為中國站廣州；中國站新加坡為 `https://tokenhub-intl.tencentmaas.com/v1`。國際站則使用其文件列出的 `tencentcloudmaas.com` 域名。程式僅接受已列入允許清單的騰訊官方 HTTPS 接口，不會自動跨站點重試。

生圖採用同步接口 `/v1/wand/hunyuan-image/v3-generation`、模型 `hy-image-v3`，每次一張 1024 × 1024 圖片。須在 TokenHub「在線推理 → 視覺模型」開通對應模型的後付費。模型列表驗證成功只代表 key 通過鑑權，不代表已開通生圖權限。圖片連結約 12 小時有效；只回傳圖片網址，不會把 API key 傳到瀏覽器。請求逾時或結果不明時，同一字句在目前伺服器程序內一小時不會再次提交，以免重複收費；重啟會清除這項記錄。

官方文件：[API 及模型列表](https://cloud.tencent.com/document/product/1823/130078)、[Hy 生圖接口與開通條件](https://cloud.tencent.com/document/product/1823/135745)。

更換 key 後，可先執行 `uv run python scripts/check_tokenhub.py`。此指令只讀取模型列表，顯示鑑權結果和圖片模型狀態，不生成內容，也不顯示 key。

### 騰訊雲混元生圖（SecretId／SecretKey 接口）

閱讀及翻譯繼續在本機進行；只有按下生圖按鈕時，才把該單字、所在句子及插畫描述送到騰訊。生圖設定和 OpenAI 文字解釋分開，不需要 OpenAI key，也不需要開啟雲端文字助手。

1. 在騰訊雲開通「混元大模型」的生圖服務。
2. 將有該服務呼叫權限的 SecretId、SecretKey 填入本機 `.env`（不要放在聊天訊息或前端程式）。本次已建立空白設定檔；新安裝可複製 `.env.example`。
3. 重新啟動 Python 服務，重新整理閱讀器，再選字及按「用騰訊混元畫張圖」。

```dotenv
IMAGE_PROVIDER=tencent
TENCENT_SECRET_ID=你的SecretId
TENCENT_SECRET_KEY=你的SecretKey
TENCENT_REGION=ap-guangzhou
# 使用臨時憑證時另填 TENCENT_TOKEN
```

接駁的是 `hunyuan.tencentcloudapi.com` 的 `SubmitHunyuanImageJob` 及 `QueryHunyuanImageJob`，API 版本 `2023-09-01`。SDK 在伺服器端完成簽名，一次提交後輪詢結果，不會自動重複提交生圖。生成結果連結有效期約一小時；生成可能收費，請按騰訊帳戶實際服務權限及計費設定使用。本次未提供憑證，故未發出真正收費的生成請求。

官方文件：[提交生圖任務](https://cloud.tencent.com/document/product/1729/105969)、[查詢任務及結果有效期](https://cloud.tencent.com/document/product/1729/105970)。

### 離線圖片（另一選擇，需安裝本機生圖服務）

已實作 [Stable Diffusion WebUI 的本機 API](https://github.com/AUTOMATIC1111/stable-diffusion-webui/wiki/API) 接駁。圖片模型和服務不包含在這個小工具內：先自行安裝模型，啟动 WebUI 並帶上 `--api`，然後在 `.env` 加上：

```dotenv
LOCAL_IMAGE_URL=http://127.0.0.1:7860
IMAGE_PROVIDER=local
```

重啟閱讀器後，單字圖片會使用本機服務，**無需開啟雲端 AI**。沒有配置服務時，圖片按鈕會清楚提示不可用。服務只接受 loopback 位址；實際出圖速度、品質和記憶體需求取決於你另外安裝的模型。現在這部電腦未有已連接的圖片模型，所以本次未測試真正本機出圖。

### 可選雲端增強

如果日後想要上下文詞解、額外例句或雲端圖片生成，可設定你自己的 OpenAI API key：

```bash
cp .env.example .env
# 用文字編輯器填入 .env 的 OPENAI_API_KEY，然後重新啟動伺服器。
```

```dotenv
OPENAI_API_KEY=your-key-here
OPENAI_TEXT_MODEL=gpt-4.1-mini
OPENAI_IMAGE_MODEL=gpt-image-1
```

API key 只放在 Python 伺服器端，不會傳送到瀏覽器。模型可按帳戶可用性修改。API 使用可能收費，與 ChatGPT 訂閱分開。

在介面開啟雲端 AI 後，單字查詢及停留／重讀提示會把**選中的字及其句子**送到 OpenAI，取得繁體中文解釋。整份文件不會隨查詢上傳。若想用 OpenAI 生圖，另設 `IMAGE_PROVIDER=openai`；騰訊生圖保持獨立。圖片需再按生圖按鈕；程式不會因注視而不斷生成收費圖片。相同內容會短暫快取，重複或過密請求受到限制。錯誤時會顯示原因，並不會用假圖片冒充 AI 生成結果。

實作參照官方文件：[文字生成](https://developers.openai.com/api/docs/guides/text)、[圖片生成](https://developers.openai.com/api/docs/guides/image-generation)。實際線上結果取決於 API key、模型權限及連線。

## 支援範圍

| 來源 | 處理方式 |
| --- | --- |
| PDF | 擷取可選取的文字，重排成閱讀版面 |
| Markdown | 取出可讀文字；不執行 HTML 或程式碼 |
| TXT／貼上文字 | 保留段落，逐句逐字處理 |
| DOCX | 擷取文稿文字；不支援舊式 `.doc` |

檔案上限 20 MB，文字上限 150,000 字元。掃描 PDF 需先用其他工具 OCR；加密、損壞、空白或不支援的檔案會提示原因。PDF 多欄版面、表格和特殊字型的擷取順序可能需要人工校正；這個原型是重排式文字閱讀器，並非原 PDF 版面檢視器。

工具只追蹤**本閱讀器內匯入的文章**，不會跨應用程式讀取你整個螢幕。停留或重讀是可調整的協助訊號，不能推斷一個人是否真正理解文字。

## 資料儲存

- 文件在本機 Python 程序解析，再交由瀏覽器顯示；原始上載檔案不會寫入永久資料夾。
- 收藏、溫習進度和閱讀偏好儲存在本瀏覽器；可在介面刪除／清空收藏。匯出的詞庫檔案由你自行保管。
- API 回應僅在伺服器記憶體內短暫快取，重啟後清除。
- 預設只監聽 `127.0.0.1`，適合自己電腦使用；沒有多用戶登入或公開部署功能。

## 開發及驗證

```bash
uv sync
uv run python -m pytest
node --test tests/*.test.mjs
uv run ruff check reader tests scripts
uv run python -m reader --reload
```

後端測試使用合成 PDF／DOCX 和模擬 API，驗證解析、限制、錯誤和線上請求邊界；追蹤測試用可控制時鐘驗證停留、重讀、過期視線和暫停。真實 webcam 精度須在你的設備校準驗證，測試程式不會替你打開相機或使用收費 API。

主要結構：

```text
reader/
  app.py             FastAPI、文件及輔助 API
  documents.py       文件解析與句子／單字切分
  assistance.py      詞庫、翻譯及圖片服務
  offline.py         本機英中翻譯與繁體轉換
  tencent.py         騰訊雲混元生圖任務接駁
  tokenhub.py        TokenHub API key 與混元同步生圖接駁
  __main__.py        本機啟動入口
  static/            閱讀介面、視線追蹤及校準
scripts/
  prepare_webgazer.py 固定版本追蹤資源安裝
  prepare_offline.py  固定版本英中模型安裝
tests/               Python 與 JavaScript 核心測試
```

眼球追蹤採用 [WebGazer](https://webgazer.cs.brown.edu/)；下載的第三方程式及模型保留其原有授權。WebGazer 的 GPL 授權檔會一併下載到 `reader/static/vendor/`。英中模型基於 Jörg Tiedemann 及 Santhosh Thottingal 的 OPUS-MT，原模型採用 CC-BY 4.0；來源及署名保留於 `.models/en-zh/README.md` 和 `SOURCE.txt`。相依版本記錄於 `uv.lock`。
