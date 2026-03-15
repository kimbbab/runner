create table if not exists public.scores (
  id bigint generated always as identity primary key,
  name text not null,
  score integer not null check (score >= 0),
  difficulty text not null check (difficulty in ('easy', 'normal', 'hard')),
  created_at timestamptz not null default now()
);

create index if not exists idx_scores_difficulty_score_created
  on public.scores (difficulty, score desc, created_at asc);
