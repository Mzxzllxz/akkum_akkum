-- 아꿈교회 DB 스키마. Supabase SQL Editor에 통째로 붙여 넣고 실행합니다.
-- 여러 번 실행해도 안전합니다(이미 있으면 건너뜀).
-- 위치·대화·접속자 표시는 Realtime(Presence/Broadcast)으로 처리하므로 테이블이 없습니다.

create table if not exists public.prayers (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null default '' check (char_length(name) <= 20),
  body text not null check (char_length(btrim(body)) between 1 and 400),
  created_at timestamptz not null default now()
);

create table if not exists public.prayer_amens (
  prayer_id bigint not null references public.prayers (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (prayer_id, user_id) -- 한 사람이 한 기도에 아멘 한 번
);

create table if not exists public.candles (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day date not null default ((now() at time zone 'Asia/Seoul')::date),
  primary key (user_id, day) -- 하루(한국 시간)에 촛불 하나
);

alter table public.prayers enable row level security;
alter table public.prayer_amens enable row level security;
alter table public.candles enable row level security;

grant select, insert, delete on public.prayers, public.prayer_amens to authenticated;
grant select, insert on public.candles to authenticated;

-- 읽기는 로그인(익명 포함)한 모두, 쓰기·삭제는 본인 것만.
drop policy if exists "prayers read" on public.prayers;
create policy "prayers read" on public.prayers for select to authenticated using (true);
drop policy if exists "prayers insert own" on public.prayers;
create policy "prayers insert own" on public.prayers for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "prayers delete own" on public.prayers;
create policy "prayers delete own" on public.prayers for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists "amens read" on public.prayer_amens;
create policy "amens read" on public.prayer_amens for select to authenticated using (true);
drop policy if exists "amens insert own" on public.prayer_amens;
create policy "amens insert own" on public.prayer_amens for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "amens delete own" on public.prayer_amens;
create policy "amens delete own" on public.prayer_amens for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists "candles read" on public.candles;
create policy "candles read" on public.candles for select to authenticated using (true);
drop policy if exists "candles insert own today" on public.candles;
create policy "candles insert own today" on public.candles for insert to authenticated
  with check (user_id = (select auth.uid()) and day = (now() at time zone 'Asia/Seoul')::date);
