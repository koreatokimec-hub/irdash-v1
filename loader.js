/**
 * 재고 대시보드 — 로그인 + 데이터 로더
 *
 * 손익 대시보드(poc_sheets/webapp/loader.js)와 같은 구조다: Supabase RPC로
 * 로그인/세션/데이터조회를 처리한다. 다른 점은, 재고 dashboard.html은 원래부터
 * "/dashboard-data/summary.json", "/dashboard-data/months/{월}.json"을 fetch로
 * 받아오는 구조였다는 것 — 그래서 손익처럼 화면 코드 전체를 재울 필요 없이,
 * 이 두 fetch 자리만 Supabase 호출로 바꿔치기하면 된다(index.html의 fetchJson 참고).
 */

const SUPABASE_URL = "https://pkvrxdtyqihvjbpdysqw.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_cUbb0SrbFymgq_RuJ3j34A_FbxhRTzJ";

// 부팅 시 organization/organizationStatus/.../item(청크별) 등 여러 RPC를 한꺼번에
// Promise.all로 쏘면 동시 커넥션이 몰려 anon 권한 쪽 statement timeout(500)이 잦아진다
// (2026-09-18 확인 — service_role은 안 걸리는데 anon만 걸림, 커넥션 풀 경합으로 보임).
// 그래서 모든 RPC 호출이 공유하는 작은 동시실행 큐를 통과하게 한다.
const RPC_CONCURRENCY = 2;
let rpcActive = 0;
const rpcQueue = [];
function runRpcQueue() {
  if (rpcActive >= RPC_CONCURRENCY || !rpcQueue.length) return;
  rpcActive++;
  const { task, resolve, reject } = rpcQueue.shift();
  task().then(resolve, reject).finally(() => { rpcActive--; runRpcQueue(); });
}
function withRpcSlot(task) {
  return new Promise((resolve, reject) => {
    rpcQueue.push({ task, resolve, reject });
    runRpcQueue();
  });
}

async function supabaseRpc(fn, body, attempt = 1) {
  return withRpcSlot(async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
      return await res.json();
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise(r => setTimeout(r, 1000));
      return supabaseRpc(fn, body, attempt + 1);
    }
  });
}

let SESSION = sessionStorage.getItem('irdash_session') || '';
let ME = sessionStorage.getItem('irdash_name') || '';

// ── snake_case(Supabase 컬럼) -> camelCase(dashboard.html이 기대하는 필드명) ──
// 예: source_group -> sourceGroup, recent3_turnover -> recent3Turnover.
// 컬럼명이 이 규칙으로 정확히 만들어졌으므로(migrate.py 참고) 데이터셋마다
// 개별 매핑표를 따로 둘 필요가 없다.
function toCamel(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'id') continue;
    const camel = k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
    out[camel] = v;
  }
  return out;
}

async function getDataset(dataset, months) {
  const r = await supabaseRpc('get_dataset', { p_session_token: SESSION, p_dataset: dataset, p_months: months });
  if (!r.ok || !Array.isArray(r.rows)) throw new Error(r.error || `${dataset} 로딩 실패`);
  return r.rows.map(toCamel);
}

// item은 24개월 전부(8만행 안팎)를 한 번에 요청하면 anon 권한의 statement timeout에
// 걸린다(service_role로는 5초대, anon으로는 10초 넘게 걸려 취소됨 — 2026-09-18 확인).
// 6개월씩 나눠 병렬로 받는다(한 묶음 약 1~2초).
const ITEM_CHUNK_SIZE = 6;
async function getItemDataset(months) {
  const chunks = [];
  for (let i = 0; i < months.length; i += ITEM_CHUNK_SIZE) chunks.push(months.slice(i, i + ITEM_CHUNK_SIZE));
  const results = await Promise.all(chunks.map(async chunk => {
    const r = await supabaseRpc('get_item_dataset', { p_session_token: SESSION, p_months: chunk });
    if (!r.ok || !Array.isArray(r.rows)) throw new Error(r.error || 'item 로딩 실패');
    return r.rows;
  }));
  return results.flat().map(toCamel);
}

// item_trend은 품목당 한 행(월별이 아니라)이라 groupByMonth 대신 code로 묶는다.
async function getItemTrend(months) {
  const r = await supabaseRpc('get_item_trend', { p_session_token: SESSION, p_months: months });
  if (!r.ok || !Array.isArray(r.rows)) throw new Error(r.error || 'itemTrend 로딩 실패');
  return r.rows.map(toCamel);
}

async function getCategoryFlowStatus(months) {
  const r = await supabaseRpc('get_category_flow_status', { p_session_token: SESSION, p_months: months });
  if (!r.ok || !Array.isArray(r.rows)) throw new Error(r.error || 'categoryFlowStatus 로딩 실패');
  return r.rows.map(toCamel);
}

function groupByMonth(rows) {
  const map = new Map();
  rows.forEach(row => {
    if (!map.has(row.month)) map.set(row.month, []);
    map.get(row.month).push(row);
  });
  return map;
}

function groupByCode(rows) {
  const map = new Map();
  rows.forEach(row => map.set(row.code, row));
  return map;
}

// ── summary.json 대체 ────────────────────────────────────────────────
let summaryCache = null;

// ── months/{월}.json 대체 ────────────────────────────────────────────
// dashboard.html이 부팅 시 전체 월을 Promise.all로 한꺼번에 요청하므로,
// 월마다 따로 RPC를 부르지 않고 데이터셋별로 "전체 월 한 번"만 받아 나눠 쓴다.
let allMonthsPromise = null;
let devProjectsCache = new Map();
const itemMonthCache = new Map();

// get_boot_bundle(supabase/get_boot_bundle.sql)로 왕복 횟수를 9->1로 줄여봤지만,
// 서버 쪽에서 그 9개 호출을 순서대로(직렬로) 처리하다 보니 원래 클라이언트가
// 갖고 있던 RPC_CONCURRENCY=3 병렬성을 잃어서 오히려 그대로거나 더 걸렸다
// (2026-09-19 확인). 병목이 왕복 지연이 아니라 쿼리 자체 실행 시간이라 번들링이
// 안 맞았다 — 그래서 다시 개별 호출 + 동시실행 큐 방식으로 되돌린다. SQL 함수
// 자체는 지워도 되지만 안 써도 무해해서 남겨둔다.

async function fetchSummary() {
  if (summaryCache) return summaryCache;
  const rows = await getDataset('summary', null); // p_month/p_months 둘 다 null이면 전체 반환
  const months = rows.map(r => r.month).sort();
  summaryCache = { meta: { availableMonths: months }, monthlySummary: rows };
  return summaryCache;
}

// item 전체 이력(24개월치 8만행)은 더 이상 부팅 시 받지 않는다. 대신
// get_item_trend(품목당 한 행, values/statuses가 월별 배열)와
// get_category_flow_status(월×구분×제품군×재고상태로 이미 서버에서 집계됨)
// 두 RPC로 대체한다 — 둘 다 원본 8만행보다 훨씬 작아서 최초 렌더를 막지 않는다.
function ensureAllMonthsLoaded(months) {
  if (!allMonthsPromise) {
    allMonthsPromise = Promise.all([
      getDataset('organization', months),
      getDataset('organizationStatus', months),
      getDataset('organizationCategory', months),
      getDataset('categoryFlow', months),
      getItemTrend(months),
      getCategoryFlowStatus(months),
    ]).then(([organization, organizationStatus, organizationCategory, categoryFlow, itemTrend, categoryFlowStatus]) => ({
      organization: groupByMonth(organization),
      organizationStatus: groupByMonth(organizationStatus),
      organizationCategory: groupByMonth(organizationCategory),
      categoryFlow: groupByMonth(categoryFlow),
      itemTrend: groupByCode(itemTrend),
      categoryFlowStatus: groupByMonth(categoryFlowStatus),
    }));
  }
  return allMonthsPromise;
}

async function fetchDevProjects(month) {
  if (devProjectsCache.has(month)) return devProjectsCache.get(month);
  const r = await supabaseRpc('get_dev_projects', { p_session_token: SESSION, p_month: month });
  if (!r.ok) throw new Error(r.error || 'devProjects 로딩 실패');
  devProjectsCache.set(month, r.data);
  return r.data;
}

async function fetchMonth(month) {
  const summary = await fetchSummary();
  const months = summary.meta.availableMonths;
  const latest = months[months.length - 1];
  const grouped = await ensureAllMonthsLoaded(months);
  const [devProjects] = await Promise.all([
    month === latest ? fetchDevProjects(month) : null,
  ]);
  return {
    organizationMonthly: grouped.organization.get(month) || [],
    organizationStatusMonthly: grouped.organizationStatus.get(month) || [],
    organizationCategoryMonthly: grouped.organizationCategory.get(month) || [],
    categoryFlowMonthly: grouped.categoryFlow.get(month) || [],
    categoryFlowStatusMonthly: grouped.categoryFlowStatus.get(month) || [],
    // raw item은 여기서 채우지 않는다 — buildDashboardData가 매번 이 함수를
    // 화면 월 범위(months) 전체에 대해 부르므로(추이 차트용), 여기서 채우면
    // 화면에 보이는 달 수만큼 8만행 문제가 되풀이된다. 실제로 쓰이는 건
    // 마지막(선택된) 달 하나뿐이라 fetchSelectedItemMonthly로 따로 뺐다
    // (index.html의 buildDashboardData 참고).
    itemMonthly: [],
    itemTrend: grouped.itemTrend,
    devProjects,
  };
}

// 상품 테이블/품목 상세 드로어가 쓰는 당월 raw item만 달마다(캐시됨) 따로 받는다.
// month별로 캐싱하므로 같은 달을 다시 선택해도 재요청하지 않는다.
function fetchSelectedItemMonthly(month) {
  if (!itemMonthCache.has(month)) itemMonthCache.set(month, getItemDataset([month]));
  return itemMonthCache.get(month);
}

// ── AI 챗봇 전용 RPC 연결 ──────────────────────────────
const AI_SUPABASE_URL = "https://tfosicfcsjdedmspffsu.supabase.co";
const AI_SUPABASE_ANON_KEY = "sb_publishable_Z2PAXLvZcP6Glu_sFuQW_w_kVL7mYk_";
let AI_SESSION = sessionStorage.getItem('irdash_ai_session') || '';

async function loginAi(name, password) {
  try {
    const res = await fetch(`${AI_SUPABASE_URL}/rest/v1/rpc/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: AI_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${AI_SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({ p_name: name, p_password: password })
    });
    const data = await res.json();
    if (data.ok && data.token) {
      AI_SESSION = data.token;
      sessionStorage.setItem('irdash_ai_session', AI_SESSION);
      return true;
    }
  } catch (e) {
    console.warn('AI login error:', e);
  }
  return false;
}

async function askAiRaw(prompt, schema) {
  if (!AI_SESSION) AI_SESSION = sessionStorage.getItem('irdash_ai_session') || '';
  if (!AI_SESSION) throw new Error('AI 세션이 준비되지 않았습니다. 로그아웃 후 다시 로그인해 주세요.');
  const res = await fetch(`${AI_SUPABASE_URL}/rest/v1/rpc/ask_ai_raw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: AI_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${AI_SUPABASE_ANON_KEY}`
    },
    body: JSON.stringify({ p_session_token: AI_SESSION, p_prompt: prompt, p_schema: schema })
  });
  if (!res.ok) throw new Error(`AI 서버 오류 (${res.status})`);
  return await res.json();
}

window.IRDASH = { fetchSummary, fetchMonth, fetchSelectedItemMonthly, askAiRaw };

// ── 로그인 화면 ──────────────────────────────────────────

function renderLoginScreen() {
  const box = document.createElement('div');
  box.id = 'irdashLogin';
  box.innerHTML = `
    <style>
      #irdashLogin{position:fixed;inset:0;background:#f4f4f6;z-index:99999;visibility:visible;
        display:flex;align-items:center;justify-content:center;
        font-family:system-ui,"Malgun Gothic",sans-serif}
      #irdashLogin .card{background:#fff;padding:24px;border-radius:12px;width:300px;
        box-shadow:0 2px 10px rgba(0,0,0,.08)}
      #irdashLogin h1{font-size:16px;margin:0 0 14px}
      #irdashLogin input{width:100%;padding:9px;margin-bottom:9px;border:1px solid #ccc;
        border-radius:7px;font-size:14px;box-sizing:border-box;transition:border-color .15s,box-shadow .15s}
      #irdashLogin input:focus{border-color:#177544;outline:none;box-shadow:0 0 0 2px rgba(23,117,68,.2)}
      #irdashLogin button{width:100%;padding:10px;background:#177544;color:#fff;
        border:none;border-radius:7px;font-weight:600;cursor:pointer;transition:background .15s}
      #irdashLogin button:hover:not(:disabled){background:#126238}
      #irdashLogin button:disabled{opacity:.5}
      #irdashLogin .msg{font-size:12.5px;color:#c62828;min-height:18px;margin-top:4px}
    </style>
    <div class="card">
      <h1>재고 대시보드 로그인</h1>
      <input id="irdashName" placeholder="이름" autocomplete="username">
      <input id="irdashPw" type="password" placeholder="비밀번호" autocomplete="current-password">
      <button id="irdashBtn">로그인</button>
      <div class="msg" id="irdashMsg"></div>
    </div>`;
  document.body.appendChild(box);

  const $ = id => document.getElementById(id);
  const submit = () => doLogin($('irdashName').value.trim(), $('irdashPw').value);
  $('irdashBtn').addEventListener('click', submit);
  $('irdashPw').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });

  try {
    const remembered = localStorage.getItem('irdash_remembered_name');
    if (remembered) { $('irdashName').value = remembered; $('irdashPw').focus(); }
  } catch (e) { /* 저장소 접근 불가면 그냥 빈 칸으로 둔다 */ }
}

let resolveReady, rejectReady;
const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
window.IRDASH.waitReady = () => readyPromise;

async function doLogin(name, password) {
  const $btn = document.getElementById('irdashBtn');
  if ($btn.disabled) return;
  const $msg = document.getElementById('irdashMsg');
  if (!name || !password) { $msg.textContent = '이름과 비밀번호를 입력하세요'; return; }

  $btn.disabled = true;
  $msg.style.color = '#555';
  $msg.textContent = '확인 중...';
  try {
    const [login] = await Promise.all([
      supabaseRpc('login', { p_name: name, p_password: password }),
      loginAi(name, password)
    ]);
    if (!login.ok) { $msg.style.color = '#c62828'; $msg.textContent = login.error; return; }

    try { localStorage.setItem('irdash_remembered_name', login.name); } catch (e) { /* 무시 */ }

    SESSION = login.session || login.token; ME = login.name;
    sessionStorage.setItem('irdash_session', SESSION);
    sessionStorage.setItem('irdash_name', ME);

    document.getElementById('irdashLogin')?.remove();
    resolveReady();
  } catch (e) {
    $msg.style.color = '#c62828';
    $msg.textContent = '연결 실패: ' + e.message;
  } finally {
    if ($btn) $btn.disabled = false;
  }
}

function clearAllSessions() {
  sessionStorage.removeItem('irdash_session');
  sessionStorage.removeItem('irdash_name');
  sessionStorage.removeItem('irdash_ai_session');
  SESSION = '';
  AI_SESSION = '';
}

async function doLogout() {
  try { await supabaseRpc('logout', { p_session_token: SESSION }); } catch (e) { /* 실패해도 로컬은 지운다 */ }
  clearAllSessions();
  location.reload();
}
window.IRDASH.logout = doLogout;

async function boot() {
  if (SESSION) {
    // 기존 세션이 살아있는지 확인만 한다 — 실제 데이터는 fetchSummary/fetchMonth가
    // 필요할 때 직접 부른다(loginAndBoot는 요약/조직/구분만 주고 나머지는 없음).
    const r = await supabaseRpc('get_boot', { p_session_token: SESSION });
    if (r.ok) {
      document.getElementById('irdashLogin')?.remove();
      resolveReady();
      return;
    }
    clearAllSessions();
  }
  renderLoginScreen();
}

boot().catch(e => { console.error(e); renderLoginScreen(); });
