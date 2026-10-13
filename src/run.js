// Một lần chạy đầy đủ: quét bài viết -> đọc share -> kiểm tra thành viên -> ghi sheet.
import { ROOT_DIR } from './config.js';
import { loadState, saveState, saveResults } from './state.js';
import { acquireRunLock, releaseRunLock } from './lock.js';
import { launchBrowser, assertLoggedIn } from './browser.js';
import { collectPostComments } from './fb/post.js';
import { collectShares } from './fb/shares.js';
import { checkMembership, cachedMemberStatus } from './fb/members.js';
import { checkProfileShare, cachedShareStatus, postIdFromUrl } from './fb/profileShares.js';
import { groupByUser, buildRecords, summarize, STATUS } from './rules.js';
import {
  createSheetsClient,
  TABS,
  MAIN_HEADER,
  REJECTED_HEADER,
  buildMainRows,
  buildRejectedRows,
  mergeHistory,
  buildSystemRows,
  mergeManual,
} from './sheets.js';
import { formatDateTime, dateKey, truncate } from './util.js';

// Số lần liên tiếp đọc được ít bình luận bất thường trước khi chấp nhận là bình luận bị xoá thật.
export const MAX_LOW_COMMENT_RUNS = 3;

/** Đã chốt: qua mốc freezeAt, hoặc lần chạy chốt cuối cho đúng mốc này đã xong. */
export function isFrozen(config, now = new Date(), state) {
  if (state?.finalRunFor && state.finalRunFor === config.freezeAt) return true;
  return now.getTime() >= config.freezeDate.getTime();
}

/** Lần chạy bắt đầu trong khoảng [finalRunDate, freezeDate) là lần chốt cuối. */
export function isFinalRun(config, now = new Date()) {
  return now.getTime() >= config.finalRunDate.getTime() && now.getTime() < config.freezeDate.getTime();
}

/**
 * So số bình luận đọc được với lần chạy thành công trước. Tụt dưới minRatio thì không ghi đè sheet,
 * trừ khi đã tụt maxLowRuns lần liên tiếp (khi đó coi là bình luận bị xoá thật).
 * @returns {{ ok: boolean, lowRuns: number }}
 */
export function checkCommentDrop({ count, lastCount, minRatio, lowRuns = 0, maxLowRuns = MAX_LOW_COMMENT_RUNS }) {
  if (!lastCount || !minRatio || count >= lastCount * minRatio) return { ok: true, lowRuns: 0 };
  const next = lowRuns + 1;
  return { ok: next >= maxLowRuns, lowRuns: next };
}

/** Ghi tab Hệ thống khi đã chốt (chỉ ghi một lần cho mỗi mốc freezeAt). */
async function handleFrozen(config, state, logger) {
  const now = new Date();
  const freezeText = formatDateTime(config.freezeDate, config.timezone);
  if (now < config.freezeDate) logger.info(`Đã chạy lần chốt cuối trước mốc ${freezeText}. Không cập nhật nữa.`);
  else logger.info(`Đã qua mốc chốt ${freezeText}. Không cập nhật nữa.`);
  if (state.frozenNotifiedFor === config.freezeAt) return;
  const sheets = createSheetsClient(config.serviceAccountPath);
  await sheets.ensureTabs(config.sheetId, [TABS.SYSTEM]);
  const rows = await sheets.readRange(config.sheetId, `'${TABS.SYSTEM}'!A1:B20`);
  const current = Object.fromEntries(rows.slice(1).map((r) => [r[0], r[1]]));
  await sheets.writeTable(
    config.sheetId,
    TABS.SYSTEM,
    ['Mục', 'Giá trị'],
    buildSystemRows({
      lastRun: current['Lần chạy gần nhất'] || '',
      result: 'ĐÃ CHỐT - số liệu giữ nguyên từ lần cập nhật cuối',
      postUrl: config.postUrl,
      commentCount: current['Số bình luận quét được'] || '',
      userCount: current['Số user có bình luận'] || '',
      qualified: current['Đủ điều kiện'] || '',
      pending: current['Chờ duyệt'] || '',
      rejected: current['Loại (tab Danh sách)'] || '',
      rejectedTags: current['Không đủ tag (tab Bị loại)'] || '',
      shareCount: current['Người chia sẻ đọc được'] || '',
      shareNote: current['Ghi chú share'] || '',
      memberChecks: '',
      freezeAt: freezeText,
      freezeStatus: `ĐÃ CHỐT lúc ${formatDateTime(now, config.timezone)}`,
      lastError: '',
    }).slice(1),
  );
  state.frozenNotifiedAt = now.toISOString();
  state.frozenNotifiedFor = config.freezeAt;
  saveState(ROOT_DIR, state);
  logger.info('Đã ghi trạng thái ĐÃ CHỐT lên tab Hệ thống.');
}

export async function runOnce(config, logger) {
  const state = loadState(ROOT_DIR);
  // Mọi mốc thời gian của lần chạy (ngày trong tab Lịch sử, lần chốt cuối) tính theo lúc bắt đầu,
  // để lần chạy bắt đầu trước 00:00 nhưng ghi xong sau 00:00 vẫn thuộc về ngày cũ.
  const startedAt = new Date();
  if (isFrozen(config, startedAt, state)) {
    await handleFrozen(config, state, logger);
    return { frozen: true };
  }

  acquireRunLock(ROOT_DIR);
  try {
    // Đọc lại state sau khi giữ khoá, phòng lần quét trước vừa ghi xong.
    return await scan(config, logger, loadState(ROOT_DIR), startedAt);
  } finally {
    releaseRunLock(ROOT_DIR);
  }
}

function commentSummary(comment) {
  if (!comment) return null;
  return {
    text: truncate(comment.text, 1000),
    url: comment.url || '',
    createdAt: comment.createdAt ? new Date(comment.createdAt).toISOString() : null,
  };
}

/** Bản gọn của kết quả để lưu data/results.json cho giao diện quản lý. */
function resultsSnapshot({ startedAt, finalRun, config, stats, sharesAvailable, records, rejected, state }) {
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    finalRun,
    postUrl: config.postUrl,
    stats,
    sharesAvailable,
    records: records.map((r) => ({
      uid: r.uid,
      name: r.name,
      profileUrl: r.profileUrl,
      status: r.status,
      reasons: r.reasons,
      tagCount: r.tagCount,
      memberAuto: r.memberAuto,
      memberLabel: r.memberLabel,
      memberEvidence: state.members[r.uid]?.evidence || '',
      shareAuto: r.shareAuto,
      sharePrivacy: r.sharePrivacy,
      shareLabel: r.shareLabel,
      manualDecision: r.manualDecision,
      manualNote: r.manualNote,
      likes: r.likes,
      replies: r.replies,
      engagement: r.engagement,
      candidateCount: r.candidateCount,
      comment: commentSummary(r.comment),
    })),
    rejected: rejected.map((r) => ({
      uid: r.uid,
      name: r.name,
      profileUrl: r.profileUrl,
      reason: r.reason,
      tagCount: r.tagCount,
      comment: commentSummary(r.comment),
    })),
  };
}

async function scan(config, logger, state, startedAt) {
  const finalRun = isFinalRun(config, startedAt);
  if (finalRun) logger.info('Đây là lần chạy chốt cuối, sau lần này tool không cập nhật nữa.');

  // Kiểm tra sheet trước khi mở trình duyệt để báo lỗi cấu hình sớm.
  const sheets = createSheetsClient(config.serviceAccountPath);
  const tabIds = await sheets.ensureTabs(config.sheetId, Object.values(TABS));
  if (!state.sheetFormatted) {
    await sheets.formatMainTab(config.sheetId, tabIds);
    state.sheetFormatted = true;
    saveState(ROOT_DIR, state);
  }

  let context;
  let lastError = '';
  const stats = { commentCount: 0, userCount: 0, shareCount: 0, shareNote: '', memberChecks: 0, shareChecks: 0 };
  try {
    context = await launchBrowser(config);
    const page = context.pages()[0] || (await context.newPage());
    await assertLoggedIn(context);

    const { comments } = await collectPostComments(page, config, logger, { rootDir: ROOT_DIR });
    stats.commentCount = comments.size;
    if (comments.size === 0) {
      throw new Error(
        'Không đọc được bình luận nào. Kiểm tra lại postUrl, tài khoản có xem được bài không, hoặc bật debug.dumpGraphql để gửi dữ liệu cho dev.',
      );
    }

    // Lần quét tải thiếu (Facebook giới hạn, chạm maxExpandClicks...) sẽ làm mất user khỏi sheet: không ghi đè.
    const drop = checkCommentDrop({
      count: comments.size,
      // Đổi sang bài viết khác thì không so với số bình luận của bài cũ.
      lastCount: state.lastPostUrl === config.postUrl ? state.lastCommentCount : null,
      minRatio: config.limits.minCommentRatio,
      lowRuns: state.lowCommentRuns,
    });
    state.lowCommentRuns = drop.lowRuns;
    saveState(ROOT_DIR, state);
    if (!drop.ok) {
      throw new Error(
        `Chỉ đọc được ${comments.size} bình luận, ít hơn nhiều so với ${state.lastCommentCount} ở lần chạy trước (có thể Facebook tải thiếu). Giữ nguyên sheet, thử lại lần sau (${drop.lowRuns}/${MAX_LOW_COMMENT_RUNS}).`,
      );
    }
    if (drop.lowRuns > 0) {
      logger.warn(
        `Số bình luận thấp ${MAX_LOW_COMMENT_RUNS} lần liên tiếp (${comments.size}/${state.lastCommentCount}), coi là bình luận đã bị xoá thật và cập nhật sheet.`,
      );
    }

    const shareResult = await collectShares(page, config, logger, { rootDir: ROOT_DIR });
    stats.shareCount = shareResult.sharers.size;
    stats.shareTotal = shareResult.shareTotal;
    stats.shareNote = shareResult.note;

    const users = groupByUser(comments.values(), config.rules);
    stats.userCount = users.size;

    // Kiểm tra thành viên cho những user có bình luận đủ tag, dùng cache 24 giờ.
    const memberStatus = {};
    const toCheck = [];
    for (const [uid, entry] of users) {
      if (!entry.best) continue;
      const cached = cachedMemberStatus(state, uid, config.limits.memberCacheHours);
      if (cached) memberStatus[uid] = cached;
      else if (config.memberCheck === 'auto') toCheck.push(uid);
      else memberStatus[uid] = 'unknown';
    }
    if (toCheck.length) {
      const batch = toCheck.slice(0, config.limits.maxMemberChecksPerRun);
      logger.info(`Kiểm tra thành viên group: ${batch.length}/${toCheck.length} user (phần còn lại ở lần chạy sau).`);
      for (const uid of batch) {
        const result = await checkMembership(page, config, uid, logger);
        state.members[uid] = { status: result.status, evidence: result.evidence, checkedAt: new Date().toISOString() };
        memberStatus[uid] = result.status;
        stats.memberChecks += 1;
        saveState(ROOT_DIR, state);
      }
      for (const uid of toCheck.slice(batch.length)) memberStatus[uid] = state.members[uid]?.status || 'unknown';
    }

    // Kiểm tra share công khai trên trang cá nhân cho người đủ tag chưa có trong danh sách chia sẻ.
    // Đã thấy share thì nhớ luôn (cho đúng bài này); chưa thấy / không xem được thì kiểm tra lại sau shareCacheHours.
    const profileShares = {};
    const postId = postIdFromUrl(config.postUrl);
    const applyProfileShare = (uid, r) => {
      if (r.status === 'shared' || r.status === 'shared_private') {
        shareResult.sharers.set(uid, {
          id: uid,
          name: users.get(uid)?.author?.name || '',
          privacy: r.privacy || (r.status === 'shared' ? 'Công khai' : ''),
          isPublic: r.status === 'shared',
          source: 'profile',
        });
      } else {
        profileShares[uid] = r.status;
      }
    };
    if (config.shareCheck === 'auto' && postId) {
      const shareQueue = [];
      for (const [uid, entry] of users) {
        if (!entry.best || shareResult.sharers.has(uid)) continue;
        const cached = cachedShareStatus(state, uid, postId, config.limits.shareCacheHours);
        if (cached) applyProfileShare(uid, cached);
        else shareQueue.push(uid);
      }
      const batch = shareQueue.slice(0, config.limits.maxShareChecksPerRun);
      if (batch.length) logger.info(`Kiểm tra share trên trang cá nhân: ${batch.length}/${shareQueue.length} user (phần còn lại ở lần chạy sau).`);
      for (const uid of batch) {
        const result = await checkProfileShare(page, config, uid, postId, logger);
        state.profileShares[uid] = { postId, ...result, checkedAt: new Date().toISOString() };
        applyProfileShare(uid, state.profileShares[uid]);
        stats.shareChecks += 1;
        saveState(ROOT_DIR, state);
      }
      // Người chưa tới lượt kiểm tra lần này: dùng kết quả cũ nếu có.
      for (const uid of shareQueue.slice(batch.length)) {
        const old = state.profileShares[uid];
        if (old?.postId === postId) applyProfileShare(uid, old);
      }
      const confirmed = [...shareResult.sharers.values()].filter((s) => s.source === 'profile' && s.isPublic).length;
      logger.info(`Share công khai xác nhận qua trang cá nhân: ${confirmed} người.`);
    } else if (config.shareCheck === 'auto' && !postId) {
      logger.warn('Không đọc được mã bài từ postUrl, bỏ qua kiểm tra share trên trang cá nhân.');
    }
    stats.shareCount = shareResult.sharers.size;

    // Đọc cột duyệt tay và gộp với bản lưu trong state.json, để user tạm biến khỏi sheet vẫn giữ quyết định.
    const existingMain = await sheets.readRange(config.sheetId, `'${TABS.MAIN}'!A1:R5000`);
    state.manual = mergeManual(state.manual, existingMain);
    saveState(ROOT_DIR, state);

    const { records, rejected } = buildRecords({
      users,
      sharers: shareResult.sharers,
      memberStatus,
      manual: state.manual,
      sharesAvailable: shareResult.found,
      profileShares,
      rules: config.rules,
      now: new Date(),
    });
    const counts = summarize(records);

    await sheets.writeTable(config.sheetId, TABS.MAIN, MAIN_HEADER, buildMainRows(records, config.timezone));
    await sheets.writeTable(config.sheetId, TABS.REJECTED, REJECTED_HEADER, buildRejectedRows(rejected, config.timezone));

    const historyRows = await sheets.readRange(config.sheetId, `'${TABS.HISTORY}'!A1:G50000`);
    const merged = mergeHistory(historyRows, records, {
      dayKey: dateKey(startedAt, config.timezone),
      timeZone: config.timezone,
      now: new Date(),
    });
    await sheets.writeTable(config.sheetId, TABS.HISTORY, merged[0], merged.slice(1));

    await sheets.writeTable(
      config.sheetId,
      TABS.SYSTEM,
      ['Mục', 'Giá trị'],
      buildSystemRows({
        lastRun: `${formatDateTime(startedAt, config.timezone)} (xong lúc ${formatDateTime(new Date(), config.timezone)})`,
        result: finalRun ? 'Thành công - lần chạy chốt cuối' : 'Thành công',
        postUrl: config.postUrl,
        commentCount: stats.commentCount,
        userCount: stats.userCount,
        qualified: counts[STATUS.QUALIFIED],
        pending: counts[STATUS.PENDING],
        rejected: counts[STATUS.REJECTED],
        rejectedTags: rejected.length,
        shareCount: stats.shareCount,
        shareNote: stats.shareNote,
        memberChecks: stats.memberChecks,
        freezeAt: formatDateTime(config.freezeDate, config.timezone),
        freezeStatus: 'Đang cập nhật',
        lastError: '',
      }).slice(1),
    );

    saveResults(
      ROOT_DIR,
      resultsSnapshot({ startedAt, finalRun, config, stats, sharesAvailable: shareResult.found, records, rejected, state }),
    );

    state.lastRun = startedAt.toISOString();
    state.lastError = null;
    state.lastCommentCount = comments.size;
    state.lastPostUrl = config.postUrl;
    state.lowCommentRuns = 0;
    if (finalRun) state.finalRunFor = config.freezeAt;
    saveState(ROOT_DIR, state);
    logger.info(
      `Hoàn tất: ${records.length} user đủ tag (${counts[STATUS.QUALIFIED]} đủ điều kiện, ${counts[STATUS.PENDING]} chờ duyệt, ${counts[STATUS.REJECTED]} loại), ${rejected.length} user không đủ tag.`,
    );
    if (finalRun) {
      await handleFrozen(config, state, logger);
      return { frozen: true, counts, rejected: rejected.length, stats };
    }
    return { frozen: false, counts, rejected: rejected.length, stats };
  } catch (err) {
    lastError = err.message;
    logger.error(`Lần chạy thất bại: ${err.message}`, err);
    state.lastError = { at: new Date().toISOString(), message: err.message };
    saveState(ROOT_DIR, state);
    try {
      await sheets.writeRange(config.sheetId, `'${TABS.SYSTEM}'!A16:B16`, [['Lỗi gần nhất', `${formatDateTime(new Date(), config.timezone)}: ${lastError}`]]);
    } catch (writeErr) {
      logger.warn(`Không ghi được lỗi lên sheet: ${writeErr.message}`);
    }
    throw err;
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
