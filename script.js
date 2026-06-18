import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getFirestore, collection, query, orderBy, limit, onSnapshot } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyC0Q3rb95mzrlPAfkOmAhFxbDzvxVTeH6c",
    authDomain: "farm-gauge.firebaseapp.com",
    projectId: "farm-gauge",
    storageBucket: "farm-gauge.firebasestorage.app",
    messagingSenderId: "618463173182",
    appId: "1:618463173182:web:7fdc8b05df885efa898f6f"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

const loginBtn = document.getElementById('login-btn');
const mainContent = document.getElementById('main-content');

let sensorDataLog = [];
let chart;
let isSubscribed = false; 

const targetKeys = [
    "temp1n", "soil1n", "temp2n", "soil2n", "temp3n", "soil3n",
    "temp4n", "soil4n", "temp5n", "soil5n", "temp6n", "soil6n",
    "temp7n", "soil7n", "temp8n", "soil8n", "temp9n", "soil9n"
];

// --- UI操作系 ---

// 時計更新
setInterval(() => {
    const now = new Date();
    const month = now.getMonth() + 1;
    const date = now.getDate();
    const time = now.toLocaleTimeString();

    document.getElementById('clock').textContent = `${month}月${date}日 ${time}`;
}, 1000);

// ハンバーガーメニューの開閉
document.addEventListener('DOMContentLoaded', () => {
    const hamburger = document.querySelector('.menu-button');
    const nav = document.getElementById('nav-menu');
    const overlay = document.getElementById('overlay');

    if(hamburger && nav && overlay) {
        hamburger.addEventListener('click', () => {
            hamburger.classList.toggle('active');
            nav.classList.toggle('active');
            overlay.classList.toggle('active');
            const isOpen = hamburger.classList.contains('active');
            hamburger.setAttribute('aria-expanded', isOpen);
            nav.setAttribute('aria-hidden', !isOpen);
        });

        overlay.addEventListener('click', () => {
            hamburger.classList.remove('active');
            nav.classList.remove('active');
            overlay.classList.remove('active');
            hamburger.setAttribute('aria-expanded', false);
            nav.setAttribute('aria-hidden', true);
        })
    }

    const yMinInput = document.getElementById('y-min');
    const yMaxInput = document.getElementById('y-max');

    if (yMinInput && yMaxInput) {
        const savedYMin = localStorage.getItem('chartYMin');
        const savedYMax = localStorage.getItem('chartYMax');

        if (savedYMin !== null) yMinInput.value = savedYMin;
        if (savedYMax !== null) yMaxInput.value = savedYMax;

        // 'input'イベントにすることで、キーボード入力や矢印上下ボタンの長押しにも即座に反応します
        yMinInput.addEventListener('input', () => {
            localStorage.setItem('chartYMin', yMinInput.value);
            if (sensorDataLog.length > 0) drawMultiChart();
        });
        yMaxInput.addEventListener('input', () => {
            localStorage.setItem('chartYMax', yMaxInput.value);
            if (sensorDataLog.length > 0) drawMultiChart();
        });
    }
    //ダークモード
    const themeCheckbox = document.getElementById('checkbox-theme');
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-mode');
        if(themeCheckbox) themeCheckbox.checked = true;
    } else {
        document.body.classList.remove('dark-mode');
        if(themeCheckbox) themeCheckbox.checked = false;
    }

    if (themeCheckbox) {
        themeCheckbox.addEventListener('change', (e) => {
            const isDark = e.target.checked;
            if(isDark) {
                document.body.classList.add('dark-mode');
                localStorage.setItem('theme', 'dark');
            } else {
                document.body.classList.remove('dark-mode');
                localStorage.setItem('theme', 'light');
            }

            if(typeof sensorDataLog !== 'undefined' && sensorDataLog.length > 0) {
                if(typeof drawMultiChart === 'function') drawMultiChart();
            }
        });
    }
});

// --- Firebase 認証系 ---

// ログインボタン処理
loginBtn.addEventListener('click', async () => {
    if (auth.currentUser) {
        await auth.signOut().catch(console.error);
    } else {
        try {
            await signInWithPopup(auth, provider);
        } catch (error) {
            console.error("ログインエラー:", error);
        }
    }
});

// 認証状態の監視
onAuthStateChanged(auth, (user) => {
    if (user) {
        if (mainContent) mainContent.style.display = 'flex'; 
        loginBtn.textContent = "Logout";
        startFetchingData(); 
    } else {
        if (mainContent) mainContent.style.display = 'none';
        loginBtn.textContent = "Login";
    }
});

// --- データ取得・描画系 ---
//絶対的な閾値
const VALID_MIN_TEMP = -10;
const VALID_MAX_TEMP = 60;
//相対的な閾値
const SPIKE_THRESHOLD = 3.0;

function cleanData(dataLog) {
    // 1. 第一段階：絶対的な範囲外の数値を null にする
    let cleaned = dataLog.map(entry => {
        let values = { ...entry.values };
        targetKeys.forEach(key => {
            let val = values[key];
            if (val !== null && val !== undefined) {
                if (val < VALID_MIN_TEMP || val > VALID_MAX_TEMP) {
                    values[key] = null;
                }
            }
        });
        return { ...entry, timestamp: entry.timestamp, values: values };
    });

    // 2. 第二段階：前後のデータを参照して、突発的な外れ値を除去する
    for (let i = 1; i < cleaned.length - 1; i++) {
        targetKeys.forEach(key => {
            let current = cleaned[i].values[key];
            if (current === null) return; // すでにnullならスキップ

            // 直前の「有効な」値を探す
            let prev = null;
            for (let p = i - 1; p >= 0; p--) {
                if (cleaned[p].values[key] !== null) {
                    prev = cleaned[p].values[key];
                    break;
                }
            }

            // 直後の「有効な」値を探す
            let next = null;
            for (let n = i + 1; n < cleaned.length; n++) {
                if (cleaned[n].values[key] !== null) {
                    next = cleaned[n].values[key];
                    break;
                }
            }

            // 前後のデータが両方とも見つかった場合のみ判定を行う
            if (prev !== null && next !== null) {
                let diffPrev = current - prev;
                let diffNext = current - next;

                // 山（前後の両方よりも閾値以上大きい） または 谷（前後の両方よりも閾値以上小さい）
                if ((diffPrev > SPIKE_THRESHOLD && diffNext > SPIKE_THRESHOLD) ||
                    (diffPrev < -SPIKE_THRESHOLD && diffNext < -SPIKE_THRESHOLD)) {
                    
                    cleaned[i].values[key] = null; // 外れ値として無効化する
                }
            }
        });
    }

    return cleaned;
}

function startFetchingData() {
    if (isSubscribed) return;
    
    const q = query(collection(db, "sensor_logs"), orderBy("timestamp", "desc"), limit(300));
    onSnapshot(q, (snapshot) => {
        let rawDataLog = snapshot.docs.map(doc => doc.data()).reverse();
        
        //取得したデータにクレンジング処理をかける
        sensorDataLog = cleanData(rawDataLog);
        
        console.log("データ受信:", sensorDataLog.length + "件");
        
        if(sensorDataLog.length > 0) {
            updateUI();
        }
    });
    isSubscribed = true;
}

function updateUI() {
    showCurrentAverages();
    drawMultiChart();
}

function calculateAverage(startTime, endTime) {
    const recent = sensorDataLog.filter(entry => {
        const t = new Date(entry.timestamp);
        return t >= startTime && t <= endTime;
    });

    if (recent.length === 0) return null;

    const sum = {};
    const count = {};

    targetKeys.forEach(key => {
        sum[key] = 0;
        count[key] = 0;
    });

    recent.forEach(entry => {
        targetKeys.forEach(key => {
            const val = entry.values[key];
            if (val != null) { 
                sum[key] += val;
                count[key] += 1;
            }
        });
    });

    const averages = {};
    targetKeys.forEach(key => {
        if (count[key] > 0) {
            averages[key] = sum[key] / count[key];
        } else {
            averages[key] = null;
        }
    });
    
    return averages;
}

function showCurrentAverages() {
    const now = new Date();
    const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const avg = calculateAverage(start, now);
    if(avg) updateIndividualDisplays(avg, ""); 
}

function updateIndividualDisplays(avg, suffix) {
    targetKeys.forEach(key => {
        const elementId = key + "-avg" + suffix;
        const element = document.getElementById(elementId);
        if (element) {
            if (avg[key] !== null) {
                element.textContent = avg[key].toFixed(1) + " °C";
            } else {
                element.textContent = "--";
            }
        }
    });
}

// グラフ描画
function drawMultiChart() {
    const yMinInput = document.getElementById("y-min");
    const yMaxInput = document.getElementById("y-max");
    const yMin = yMinInput && yMinInput.value !== "" ? parseFloat(yMinInput.value) : 10;
    const yMax = yMaxInput && yMaxInput.value !== "" ? parseFloat(yMaxInput.value) : 40;
    const now = new Date();
    const timeWindow = 48 * 60 * 60 * 1000;
    const recentData = sensorDataLog.filter(entry => new Date(entry.timestamp) > new Date(now.getTime() - timeWindow));
    
    if (recentData.length === 0) return;
    const isDark = document.body.classList.contains('dark-mode');
    const chartTextColor = isDark ? "#94a3b8" : "#666666";    // 目盛り・タイトルの文字色
    const chartGridColor = isDark ? "#334155" : "#e0e0e0";    // 背景のグリッド線の色
    const midnightLineColor = isDark ? "#475569" : "#cccccc"; // 深夜0時の区切り線の色

    const labels = recentData.map(entry => new Date(entry.timestamp));
    
    const datasets = [
        // 線が白背景で見えるように濃いめの色に変更したい場合はここを調整（今回は既存の色を維持）
        { label: "House1気温", key: "temp1n", color: "#ef5350" },
        { label: "House1地温", key: "soil1n", color: "#ff7043" },
        { label: "House2気温", key: "temp2n", color: "#ffb74d" },
        { label: "House2地温", key: "soil2n", color: "#ffd54f" },
        { label: "House3気温", key: "temp3n", color: "#fff176" },
        { label: "House3地温", key: "soil3n", color: "#dce775" },
        { label: "House4気温", key: "temp4n", color: "#81c784" },
        { label: "House4地温", key: "soil4n", color: "#aed581" },
        { label: "House5気温", key: "temp5n", color: "#4db6ac" },
        { label: "House5地温", key: "soil5n", color: "#4dd0e1" },
        { label: "House6気温", key: "temp6n", color: "#4fc3f7" },
        { label: "House6地温", key: "soil6n", color: "#64b5f6" },
        { label: "House7気温", key: "temp7n", color: "#7986cb" },
        { label: "House7地温", key: "soil7n", color: "#9575cd" },
        { label: "House8気温", key: "temp8n", color: "#ba68c8" },
        { label: "House8地温", key: "soil8n", color: "#f06292" },
        { label: "House9気温", key: "temp9n", color: "#e57373" },
        { label: "House9地温", key: "soil9n", color: "#a1887f" },
    ].map(setting => ({
        label: setting.label + " (°C)",
        data: recentData.map(e => e.values[setting.key] ?? null),
        borderColor: setting.color,
        backgroundColor: setting.color + "33",
        yAxisID: "y1",
        tension: 0.3,
        fill: false,
        spanGaps: true,
        pointRadius: 0
    }));

    const midnightLinesPlugin = {
        id: 'midnightLines',
        afterDraw: (chart) => {
            const xAxis = chart.scales.x;
            const yAxis = chart.scales.y1;
            if (!xAxis || !yAxis) return;
            const ctx = chart.ctx;
            const min = xAxis.min;
            const max = xAxis.max;
            let current = new Date(min);
            current.setHours(0, 0, 0, 0);
            while (current.getTime() <= max) {
                if (current.getTime() >= min) {
                    const x = xAxis.getPixelForValue(current);
                    ctx.save();
                    ctx.beginPath();
                    ctx.moveTo(x, yAxis.top);
                    ctx.lineTo(x, yAxis.bottom);
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = midnightLineColor; // 白背景用に線を濃く
                    ctx.setLineDash([4, 4]);
                    ctx.stroke();
                    ctx.restore();
                }
                current.setDate(current.getDate() + 1);
            }
        }
    };

    if (chart) chart.destroy();
    
    chart = new Chart(document.getElementById("multchart"), {
        type: "line",
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false, 
            animation: false,
            plugins: {
                legend: { display: false },
                title: { display: true, color: chartTextColor } // 白背景用に文字を濃く
            },
            scales: {
                x: {
                    type: 'time',
                    time: { 
                        unit: 'hour', 
                        displayFormats: { hour: 'HH:mm' }, 
                        stepSize: 6
                    },
                    ticks: { color: chartTextColor, maxRotation: 0, autoSkip: true },
                    grid: { color: chartGridColor }, // 白背景用のグリッド色
                    max: (function() {
                        const d = new Date();
                        d.setMinutes(0,0,0);
                        d.setHours(d.getHours() + 3);
                        return d;
                    })(),
                    min: new Date(now.getTime() - timeWindow)
                },
                y1: {
                    type: "linear",
                    position: "left",
                    ticks: { color: chartTextColor, stepSize: 5 },
                    grid: { color: chartGridColor }, // 白背景用のグリッド色
                    min: yMin,
                    max: yMax
                }
            }
        },
        plugins: [midnightLinesPlugin]
    });
}
