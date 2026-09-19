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
-- 파라미터 이름은 추측이 아니다: loader.js가 이미 이 이름들로 각 RPC를 성공적으로
-- 호출하고 있고(PostgREST는 JSON 바디의 키를 함수 파라미터 이름과 정확히 매칭해야
-- 호출이 성립한다), 아래에서도 위치가 아니라 이름(:=)으로 호출해 선언 순서와
-- 무관하게 맞도록 했다. 유일하게 못 미더운 건 p_months의 실제 타입뿐이다(text[]로
-- 가정) — SQL Editor에서 그냥 실행해보고, 타입 에러가 나면 그 메시지를 알려줄 것
-- (jsonb 등으로 바꿔서 다시 줄 수 있다).

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
  v_summary := get_dataset(p_session_token := p_session_token, p_dataset := 'summary', p_months := null);
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

  v_organization          := get_dataset(p_session_token := p_session_token, p_dataset := 'organization', p_months := v_months);
  v_organization_status   := get_dataset(p_session_token := p_session_token, p_dataset := 'organizationStatus', p_months := v_months);
  v_organization_category := get_dataset(p_session_token := p_session_token, p_dataset := 'organizationCategory', p_months := v_months);
  v_category_flow         := get_dataset(p_session_token := p_session_token, p_dataset := 'categoryFlow', p_months := v_months);
  v_item_trend            := get_item_trend(p_session_token := p_session_token, p_months := v_months);
  v_category_flow_status  := get_category_flow_status(p_session_token := p_session_token, p_months := v_months);
  v_dev_projects          := get_dev_projects(p_session_token := p_session_token, p_month := v_latest);
  v_item_dataset          := get_item_dataset(p_session_token := p_session_token, p_months := array[v_latest]);

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
