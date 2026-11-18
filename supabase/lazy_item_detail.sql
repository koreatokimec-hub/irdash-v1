-- 품목 상세 지연 로딩용 서버 함수 2개 (초안 — 아직 어떤 DB에도 실행하지 않았다)
--
-- 배경: 지금은 로그인하면 get_item_trend 로 "전 품목 × 전 기간(24개월)" 이력을 한 번에 받는다.
--       그래서 F12 로 보면 보지 않은 달·품목 상세까지 전부 들어 있다.
-- 변경: 부팅 때는 선택 월 + 전월 2개월만(기존 get_item_trend 를 p_months=2개월로 재사용) 받고,
--       ① 구분별 월 합계는 이 파일의 get_account_type_series 가 서버에서 미리 집계해 주고,
--       ② 품목 상세창을 열 때만 get_item_history 로 그 품목 하나의 전 기간을 받는다.
--
-- 실행: Supabase SQL Editor 에 붙여넣고 Run (운영 반영은 테스트 후 별도로 결정).

-- ── 1) 구분(상품/제품/원부자재)별 월 합계 + 부동(3/6/12개월) 합계 ─────────────
-- 기존 화면 계산(index.html buildDashboardData)과 같은 규칙을 그대로 옮겼다.
--  - 품목의 구분은 p_months 안에서 "가장 최근 달"의 account_type (get_item_trend 의 latest 와 동일)
--  - 원자재/부자재/반제품/원부자재 -> '원부자재', 비어 있으면 '미분류'
--  - 부동 = inventory_status 가 3개월/6개월/12개월(또는 부동재고3/6/12)
CREATE OR REPLACE FUNCTION public.get_account_type_series(p_session_token text, p_months text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_name text;
  v_rows jsonb;
begin
  v_name := validate_session(p_session_token);
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', '로그인이 필요합니다');
  end if;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_rows from (
    with latest as (
      select distinct on (code) code,
        case when account_type in ('원자재','부자재','반제품','원부자재') then '원부자재'
             else coalesce(nullif(account_type, ''), '미분류') end as atype
      from inv_item
      where month = any(p_months)
      order by code, month desc
    )
    select i.month,
           l.atype as account_type,
           sum(coalesce(i.amount, 0)) as total,
           sum(case when i.inventory_status ~ '12개월|부동재고12|6개월|부동재고6|3개월|부동재고3'
                    then coalesce(i.amount, 0) else 0 end) as risk
    from inv_item i
    join latest l on l.code = i.code
    where i.month = any(p_months)
    group by i.month, l.atype
    order by i.month, l.atype
  ) t;

  insert into access_log(user_name, action, detail)
    values (v_name, '데이터조회', 'account_type_series ' || coalesce(array_length(p_months,1)::text,'0') || '개월');

  return jsonb_build_object('ok', true, 'dataset', 'account_type_series', 'rows', v_rows);
end;
$function$;

-- ── 2) 품목 하나의 전 기간 이력 (상세창을 열 때만 호출) ──────────────────────────
CREATE OR REPLACE FUNCTION public.get_item_history(p_session_token text, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_name text;
  v_row jsonb;
begin
  v_name := validate_session(p_session_token);
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', '로그인이 필요합니다');
  end if;

  select jsonb_build_object(
           'code', p_code,
           'months',   array_agg(month order by month),
           'values',   array_agg(amount order by month),
           'statuses', array_agg(inventory_status order by month)
         )
    into v_row
  from inv_item
  where code = p_code;

  insert into access_log(user_name, action, detail)
    values (v_name, '데이터조회', 'item_history ' || coalesce(p_code, ''));

  return jsonb_build_object('ok', true, 'dataset', 'item_history', 'row', v_row);
end;
$function$;

-- 화면(anon)이 호출할 수 있게 허용. validate_session 은 계속 내부 전용이다.
grant execute on function public.get_account_type_series(text, text[]) to anon, authenticated;
grant execute on function public.get_item_history(text, text)          to anon, authenticated;
