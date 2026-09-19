-- get_boot_bundle: 로그인 직후 첫 화면을 그리는 데 필요한 모든 데이터를
-- 클라이언트 왕복 1번으로 묶어서 반환한다.
--
-- 배경: loader.js가 부팅 시 아래 순서로 최대 9번 RPC를 왕복했다(get_boot 제외).
--   get_dataset('summary') -> get_dataset('organization' 외 3종) x4
--   -> get_item_trend -> get_category_flow_status -> get_dev_projects -> get_item_dataset
-- RPC_CONCURRENCY(동시 3)로 묶어도 왕복 지연이 누적돼 체감 로딩이 느렸다.
-- 이 함수는 그 호출들을 서버 안에서 순서대로(같은 트랜잭션) 실행해 하나의
-- JSON으로 합쳐 돌려준다 — 네트워크 왕복이 여러 번에서 1번으로 준다.
--
-- ⚠️ 실행 전 확인 필요: 아래 get_dataset / get_item_trend / get_category_flow_status /
-- get_dev_projects / get_item_dataset 호출부의 파라미터 이름·타입이 실제 함수
-- 시그니처와 일치하는지 Supabase 대시보드(Database > Functions)에서 먼저 확인하고,
-- 다르면 이 파일을 고친 뒤 SQL Editor에서 실행할 것. (이 저장소엔 원본 함수들의
-- CREATE FUNCTION 정의가 없어서 loader.js의 호출부 모양만 보고 추정했다.)

create or replace function get_boot_bundle(p_session_token text)
returns json
language plpgsql
security definer
as $$
declare
  v_summary json;
  v_months text[];
  v_latest text;
  v_organization json;
  v_organization_status json;
  v_organization_category json;
  v_category_flow json;
  v_item_trend json;
  v_category_flow_status json;
  v_dev_projects json;
  v_item_dataset json;
begin
  v_summary := get_dataset(p_session_token, 'summary', null);
  if not coalesce((v_summary->>'ok')::boolean, false) then
    return v_summary; -- 세션 만료 등 -- 클라이언트가 기존과 같은 {ok:false, error} 모양을 그대로 받는다
  end if;

  select array_agg(month order by month)
    into v_months
    from (
      select distinct row->>'month' as month
      from json_array_elements(v_summary->'rows') as row
    ) months;

  v_latest := v_months[array_length(v_months, 1)];

  v_organization         := get_dataset(p_session_token, 'organization', v_months);
  v_organization_status  := get_dataset(p_session_token, 'organizationStatus', v_months);
  v_organization_category:= get_dataset(p_session_token, 'organizationCategory', v_months);
  v_category_flow        := get_dataset(p_session_token, 'categoryFlow', v_months);
  v_item_trend           := get_item_trend(p_session_token, v_months);
  v_category_flow_status := get_category_flow_status(p_session_token, v_months);
  v_dev_projects         := get_dev_projects(p_session_token, v_latest);
  v_item_dataset         := get_item_dataset(p_session_token, array[v_latest]);

  return json_build_object(
    'ok', true,
    'months', to_json(v_months),
    'latestMonth', v_latest,
    'summary', v_summary->'rows',
    'organization', v_organization->'rows',
    'organizationStatus', v_organization_status->'rows',
    'organizationCategory', v_organization_category->'rows',
    'categoryFlow', v_category_flow->'rows',
    'itemTrend', v_item_trend->'rows',
    'categoryFlowStatus', v_category_flow_status->'rows',
    'devProjects', v_dev_projects->'data',
    'itemDataset', v_item_dataset->'rows'
  );
end;
$$;

grant execute on function get_boot_bundle(text) to anon;
