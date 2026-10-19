import {
  authenticate,
  hasSameOrigin,
  json,
  type Account,
  type PagesFunction,
} from '../_utils/auth';

interface RecordInput {
  seed: string;
  slots: number;
  attributes: number;
  questionCount: number;
  elapsedMilliseconds: number;
}

interface LeaderboardRecord extends RecordInput {
  id: string;
  nickname: string;
  createdAt: string;
  userId: string | null;
}

function publicRecord(record: LeaderboardRecord) {
  return {
    id: record.id,
    nickname: record.nickname,
    seed: record.seed,
    slots: record.slots,
    attributes: record.attributes,
    questionCount: record.questionCount,
    elapsedMilliseconds: record.elapsedMilliseconds,
    createdAt: record.createdAt,
  };
}

function isRecordInput(value: unknown): value is RecordInput {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.seed === 'string' &&
    record.seed.length > 0 &&
    record.seed.length <= 64 &&
    !/[\u0000-\u001f\u007f]/.test(record.seed) &&
    typeof record.slots === 'number' &&
    Number.isInteger(record.slots) &&
    record.slots >= 3 &&
    record.slots <= 10 &&
    typeof record.attributes === 'number' &&
    Number.isInteger(record.attributes) &&
    record.attributes >= 1 &&
    record.attributes <= 3 &&
    typeof record.questionCount === 'number' &&
    Number.isSafeInteger(record.questionCount) &&
    record.questionCount >= 0 &&
    record.questionCount <= 10_000_000 &&
    typeof record.elapsedMilliseconds === 'number' &&
    Number.isSafeInteger(record.elapsedMilliseconds) &&
    record.elapsedMilliseconds >= 0 &&
    record.elapsedMilliseconds <= 315_360_000_000
  );
}

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  const url = new URL(request.url);
  const slots = Number(url.searchParams.get('slots'));
  const attributes = Number(url.searchParams.get('attributes'));
  const requestedLimit = Number(url.searchParams.get('limit') ?? 10);

  if (
    !Number.isInteger(slots) ||
    slots < 3 ||
    slots > 10 ||
    !Number.isInteger(attributes) ||
    attributes < 1 ||
    attributes > 3 ||
    !Number.isInteger(requestedLimit) ||
    requestedLimit < 1
  ) {
    return json({ error: '자리 수, 속성 수, 조회 개수를 확인하세요.' }, 400);
  }

  const limit = Math.min(requestedLimit, 50);
  try {
    const account = await authenticate(request, env);
    const result = await env.DB.prepare(
      `SELECT id, nickname, seed, slots, attributes,
              question_count AS questionCount,
              elapsed_ms AS elapsedMilliseconds,
              created_at AS createdAt,
              user_id AS userId
       FROM records
       WHERE slots = ? AND attributes = ?
       ORDER BY question_count ASC, elapsed_ms ASC, created_at ASC
       LIMIT ?`,
    )
      .bind(slots, attributes, limit)
      .all<LeaderboardRecord>();
    const ownRecords = account
      ? await env.DB.prepare(
          `SELECT id, nickname, seed, slots, attributes,
                  question_count AS questionCount,
                  elapsed_ms AS elapsedMilliseconds,
                  created_at AS createdAt,
                  user_id AS userId
           FROM records
           WHERE slots = ? AND attributes = ? AND user_id = ?
           ORDER BY question_count ASC, elapsed_ms ASC, created_at ASC`,
        )
          .bind(slots, attributes, account.id)
          .all<LeaderboardRecord>()
      : { results: [] };
    return json({
      records: result.results.map(publicRecord),
      personalRecords: ownRecords.results.map(publicRecord),
    });
  } catch (error) {
    console.error('리더보드 조회 쿼리가 실패했습니다.', error);
    return json({ error: '리더보드를 불러오지 못했습니다.' }, 500);
  }
};

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  if (!hasSameOrigin(request)) return json({ error: '허용되지 않은 요청입니다.' }, 403);

  let account: Account | null;
  try {
    account = await authenticate(request, env);
  } catch (error) {
    console.error('기록 등록 계정을 확인하지 못했습니다.', error);
    return json({ error: '로그인 상태를 확인하지 못했습니다.' }, 500);
  }
  if (!account) return json({ error: '기록을 등록하려면 로그인하세요.' }, 401);

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > 8_192) {
    return json({ error: '요청 본문이 너무 큽니다.' }, 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: 'JSON 형식이 올바르지 않습니다.' }, 400);
    throw error;
  }
  if (!isRecordInput(body)) {
    return json({ error: '기록 정보가 올바르지 않습니다.' }, 400);
  }

  const record = {
    id: crypto.randomUUID(),
    userId: account.id,
    nickname: account.username,
    seed: body.seed,
    slots: body.slots,
    attributes: body.attributes,
    questionCount: body.questionCount,
    elapsedMilliseconds: body.elapsedMilliseconds,
    createdAt: new Date().toISOString(),
  };

  try {
    const result = await env.DB.prepare(
      `INSERT INTO records
         (id, user_id, nickname, seed, slots, attributes, question_count, elapsed_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        record.id,
        record.userId,
        record.nickname,
        record.seed,
        record.slots,
        record.attributes,
        record.questionCount,
        record.elapsedMilliseconds,
        record.createdAt,
      )
      .run();
    if (!result.success) throw new Error('D1 did not save the record.');
  } catch (error) {
    console.error('리더보드 기록 저장 쿼리가 실패했습니다.', error);
    return json({ error: '기록을 저장하지 못했습니다.' }, 500);
  }

  return json({
    record: {
      id: record.id,
      nickname: record.nickname,
      seed: record.seed,
      slots: record.slots,
      attributes: record.attributes,
      questionCount: record.questionCount,
      elapsedMilliseconds: record.elapsedMilliseconds,
      createdAt: record.createdAt,
    },
  }, 201);
};

export const onRequestDelete: PagesFunction = async ({ request, env }) => {
  if (!hasSameOrigin(request)) return json({ error: '허용되지 않은 요청입니다.' }, 403);

  let account: Account | null;
  try {
    account = await authenticate(request, env);
  } catch (error) {
    console.error('기록 삭제 계정을 확인하지 못했습니다.', error);
    return json({ error: '로그인 상태를 확인하지 못했습니다.' }, 500);
  }
  if (!account) return json({ error: '기록을 삭제하려면 로그인하세요.' }, 401);

  const id = new URL(request.url).searchParams.get('id');
  if (!id || id.length > 64) return json({ error: '삭제할 기록을 확인하세요.' }, 400);

  try {
    const result = await env.DB.prepare('DELETE FROM records WHERE id = ? AND user_id = ?')
      .bind(id, account.id)
      .run();
    if (!result.success) throw new Error('D1 did not delete the record.');
    return json({ success: true });
  } catch (error) {
    console.error('리더보드 기록 삭제 쿼리가 실패했습니다.', error);
    return json({ error: '기록을 삭제하지 못했습니다.' }, 500);
  }
};
