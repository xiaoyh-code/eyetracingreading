"""Original demonstration prose and explicitly authored, offline learning material."""

TITLE = "The quiet art of noticing"

PARAGRAPHS = [
    [
        ("Every morning, Maya walked the same narrow path between her apartment and the river.", "每天早上，Maya 都沿著同一條狹窄小徑，從住所走到河邊。"),
        ("She usually filled the journey with messages, music, and plans for the day ahead.", "她通常一邊走，一邊看訊息、聽音樂，並計劃接下來的一天。"),
        ("The trees became a green blur, and the water was simply something she crossed.", "樹木變成模糊的一片綠色，而河水對她來說，只是途中要越過的東西。"),
        ("On busy mornings, she could reach the bridge without remembering a single thing along the way.", "在忙碌的早上，她走到橋邊時，甚至記不起沿途任何一件事。"),
    ],
    [
        ("One Tuesday, her headphones stopped working just as a gentle rain began to fall.", "某個星期二，細雨剛開始落下時，她的耳機突然壞了。"),
        ("Without their familiar noise, she heard tiny drops tapping on a broad leaf beside the path.", "少了熟悉的耳機聲，她聽見小水滴輕敲路旁一片闊葉的聲音。"),
        ("Each drop paused like a clear bead before sliding into the dark soil below.", "每顆水滴都像透明珠子般停留片刻，然後滑落到下面深色的泥土中。"),
    ],
    [
        ("That small interruption became an unexpected moment of serendipity.", "那個小小的意外，成了一次出乎意料的美好偶遇。"),
        ("Maya had not gone looking for anything special, yet something lovely had found her attention.", "Maya 並沒有刻意尋找特別的事物，卻有一件美好的小事吸引了她的注意。"),
        ("She put her phone away and stayed beside the leaf for another quiet minute.", "她把手機收起，在葉子旁再安靜地停留了一分鐘。"),
    ],
    [
        ("Over the next week, she began to notice details that had always been there.", "接下來的一個星期，她開始留意那些一直存在的細節。"),
        ("A pale flower grew through a crack in the pavement, turning slowly toward the light.", "一朵淡色的小花從行人路的裂縫中長出來，慢慢朝向陽光。"),
        ("Its resilience reminded her that growth sometimes happens in places that appear completely unwelcoming.", "它的韌性提醒她：成長有時會發生在看似完全不利的環境中。"),
        ("No one had planted it there, but somehow it had found enough room to begin.", "沒有人把它種在那裡，但它還是找到足夠的空間，開始生長。"),
    ],
    [
        ("Other discoveries were ephemeral: a ribbon of mist, a passing shadow, a silver pattern on the river.", "其他發現則稍縱即逝：一縷薄霧、一道掠過的影子，以及河面上的銀色波紋。"),
        ("By the time she reached for a camera, the light had changed and the pattern had disappeared.", "當她伸手拿相機時，光線已經改變，波紋也消失了。"),
        ("She learned that enjoying a moment did not always require keeping a picture of it.", "她學會了：享受一個時刻，並不一定要拍照把它留住。"),
    ],
    [
        ("Noticing did not remove her deadlines or solve the difficult questions waiting at work.", "學會留意身邊事物，並沒有替她消除工作期限，也沒有解決工作上的難題。"),
        ("It simply created a little space between one thought and the next.", "它只是讓前一個念頭與下一個念頭之間，多了一點空間。"),
        ("In that space, she could breathe more slowly and decide what deserved her energy.", "在那個空間裡，她可以放慢呼吸，決定甚麼事情值得自己投入精力。"),
        ("A short pause often helped her return to a difficult task with a clearer mind.", "短暫的停頓，常常幫助她以更清晰的頭腦重新面對困難的工作。"),
    ],
    [
        ("Soon she brought the same patient attention to the books she read in the evening.", "不久，她把同樣耐心的專注，帶到晚上的閱讀之中。"),
        ("An unfamiliar word became an invitation to pause, imagine, and explore its meaning.", "一個陌生的單字，成了邀請她停下來、想像並探索意思的契機。"),
        ("Understanding arrived less like a sudden flash and more like a landscape slowly coming into focus.", "理解的到來，不像突然閃現的光，更像一幅逐漸變得清晰的風景。"),
    ],
    [
        ("The path beside the river was still the same path, and her days were still busy.", "河邊的小徑依然是同一條小徑，她的日子也依然忙碌。"),
        ("But the world felt larger when she gave its smallest details a little more time.", "但當她多花一點時間留意最細小的事物時，世界彷彿變得更廣闊。"),
        ("She no longer needed every walk to take her somewhere new; sometimes, seeing an old place differently was enough.", "她不再要求每次散步都帶她去新地方；有時，以不同的眼光看熟悉的地方，已經足夠。"),
    ],
]

TEXT = "\n\n".join(" ".join(sentence for sentence, _ in paragraph) for paragraph in PARAGRAPHS)
TRANSLATIONS = {sentence: translation for paragraph in PARAGRAPHS for sentence, translation in paragraph}

# Meanings are short, human-authored learning aids, not a comprehensive dictionary.
DICTIONARY = {
    "serendipity": ("美好的意外發現；原本無心尋找，卻碰巧遇到有價值的事物。", "Finding a wonderful book by chance was pure serendipity.", "一個人在散步時，意外發現藏在樹後的小花園。"),
    "resilience": ("韌性；面對困難後恢復、適應並繼續前進的能力。", "The young tree showed resilience after the storm.", "暴風雨過後，一棵彎曲的小樹重新挺立。"),
    "ephemeral": ("短暫的；只存在很短的時間，轉眼就消失。", "The rainbow was beautiful but ephemeral.", "雨後的彩虹在陽光中漸漸消散。"),
    "noticing": ("留意到；開始察覺原本忽略的事物。", "She is noticing small changes in the garden.", "一個人仔細看著葉面上一滴晶瑩的露水。"),
    "narrow": ("狹窄的；兩邊距離很近。", "We followed a narrow path through the trees.", "兩排樹之間，只容一個人行走的小徑。"),
    "blur": ("模糊的一片；因移動或失焦而看不清的影像。", "The passing trees were a green blur.", "車窗外快速掠過、輪廓模糊的綠色樹木。"),
    "gentle": ("溫柔的、輕柔的；力量不強或態度柔和。", "A gentle breeze moved the leaves.", "微風吹動葉子，枝條只輕輕搖擺。"),
    "broad": ("寬闊的；有較大的寬度。", "Rain collected on the broad leaf.", "一片闊大的綠葉接住幾顆水滴。"),
    "bead": ("珠子；也可形容一小顆圓形的液體。", "A bead of water rested on the glass.", "玻璃表面上一顆圓圓的透明水珠。"),
    "soil": ("泥土；植物紮根生長的地面表層。", "The roots reached into the soft soil.", "植物的根伸進深褐色、鬆軟的泥土。"),
    "interruption": ("中斷；令原本進行中的事情暫停的事件。", "The phone call was an unexpected interruption.", "一個正在閱讀的人，被突然響起的電話打斷。"),
    "unexpected": ("意料之外的；沒有預先想到會發生。", "We received an unexpected gift.", "一個人打開門，驚喜地看到朋友送來的禮物。"),
    "attention": ("注意力；把心思集中在某件事物上。", "Give the speaker your full attention.", "一個人專注觀察桌上的花，周圍景物稍微模糊。"),
    "pale": ("淡色的；顏色淺或不鮮明。", "A pale pink flower opened in the morning.", "晨光下一朵淡粉紅色的小花。"),
    "pavement": ("行人路或鋪好的路面；在英式英語中通常指行人路。", "A flower grew through the pavement.", "行人路的灰色石板裂縫中長出一朵小花。"),
    "unwelcoming": ("不友善或不宜停留的；令人感到難以接近或生存。", "The rocky ground seemed unwelcoming to plants.", "乾旱、佈滿碎石的地面，只有一棵幼苗努力生長。"),
    "mist": ("薄霧；空氣中微小水滴形成的輕薄霧氣。", "Morning mist floated above the river.", "清晨河面上漂浮著一層淡白色薄霧。"),
    "shadow": ("影子；光線被物體擋住後形成的較暗區域。", "The tree cast a long shadow.", "午後陽光下，一棵樹在地上投下長長的影子。"),
    "pattern": ("圖案、紋理或規律；反覆出現的形狀或安排。", "The waves made a pattern of silver lines.", "陽光照在河面，形成重複的銀色波紋。"),
    "deadlines": ("截止日期；完成某件事的最後期限。", "She wrote the deadlines on her calendar.", "月曆上一個日期被圈起，旁邊放著未完成的工作。"),
    "deserved": ("值得擁有或獲得；是 deserve 的過去式。", "Her careful work deserved recognition.", "一個認真完成作品的人，獲得同伴欣賞的目光。"),
    "patient": ("耐心的；願意平靜地等待或仔細處理事情。", "A patient teacher explains the idea again.", "老師從容地陪學生一步一步完成拼圖。"),
    "unfamiliar": ("陌生的；以前未遇過，或尚未了解。", "I looked up an unfamiliar word.", "讀者在書頁上圈起一個從未見過的單字。"),
    "invitation": ("邀請；也可以指鼓勵你嘗試某件事的機會。", "The open door felt like an invitation to explore.", "一扇敞開的門，門後是一座等待探索的花園。"),
    "landscape": ("風景；一片地區中看得見的自然景物。", "Mountains filled the peaceful landscape.", "遠山、河流與草地組成寧靜的景色。"),
    "focus": ("焦點或專注；come into focus 指變得清晰。", "The distant hill slowly came into focus.", "原本模糊的遠山，逐漸呈現清楚的輪廓。"),
    "quiet": ("安靜的、平靜的；沒有太多聲音或干擾。", "We enjoyed a quiet morning beside the river.", "清晨空無一人的河岸，水面平靜。"),
    "river": ("河流；自然流動、通常流向湖泊或海洋的水道。", "The river flows through the town.", "一條河蜿蜒流過綠色山谷。"),
    "growth": ("成長、增長；逐漸變大或發展的過程。", "Sunlight supports the growth of plants.", "從種子到幼苗，再到枝葉茂盛的小樹。"),
}
