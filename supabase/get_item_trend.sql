-- get_item_trend 최적화 (2026-09-19)
--
-- 기존 버전은 inv_item을 두 번 스캔했다:
--   agg    : group by code, array_agg(...) — 월별 values/statuses/months
--   latest : distinct on (code) order by month desc — 최신 name/account_type/...
-- 두 CTE를 join해서 합쳤는데, 같은 group에서 정렬 방향만 다르게
-- array_agg를 두 번 쓰면 latest 값도 같이 뽑아낼 수 있어 스캔을 한 번으로
-- 줄였다. old/new 결과를 8,719건 전수비교해서 완전히 동일함을 확인했다
-- (mismatch_count = 0).
--
-- 실행: Supabase SQL Editor에 붙여넣고 Run. git push로는 반영되지 않는다 —
-- 이 파일은 기록용이고, 실제 DB 함수는 SQL Editor에서 직접 실행해야 바뀐다.

CREATE OR REPLACE FUNCTION public.get_item_trend(p_session_token text, p_months text[])
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
    select
      code,
      (array_agg(name order by month desc))[1] as name,
      (array_agg(account_type order by month desc))[1] as account_type,
      (array_agg(category order by month desc))[1] as category,
      (array_agg(final_category order by month desc))[1] as final_category,
      array_agg(amount order by month) as values,
      array_agg(inventory_status order by month) as statuses,
      array_agg(month order by month) as months
    from inv_item
    where month = any(p_months)
    group by code
  ) t;

  insert into access_log(user_name, action, detail)
    values (v_name, '데이터조회', 'item_trend ' || coalesce(array_length(p_months,1)::text,'0') || '개월');

  return jsonb_build_object('ok', true, 'dataset', 'item_trend', 'rows', v_rows);
end;
$function$
