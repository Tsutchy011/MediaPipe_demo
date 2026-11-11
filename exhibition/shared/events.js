// イベント記録（課題の提示、打鍵、モードの切り替えなど）
//
// - 時刻はすべて performance.now()（ミリ秒）。MediaPipe の検出時刻、MIDI の timeStamp と同じ基準。
// - 記録はページの中（メモリ）だけに置き、保存も送信もしない。
// - デバッグ用の保存は、次の2つがそろったときだけ行う（AGENTS.md「守ること」）。
//     1. ページを ?debug=1 を付けて開く
//     2. サーバーを scripts/serve.sh --debug-save で起動する
//   保存先はフォルダ直下の logs/（git 管理外）。

import { flag } from './util.js';

export class EventLog {
  constructor() {
    this.events = [];
    this.listeners = new Set();
  }

  /** イベントを記録して返す。t は performance.now() の値（省略時はいま） */
  mark(name, data = {}, t = performance.now()) {
    const ev = { t, name, ...data };
    this.events.push(ev);
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch (e) {
        console.error(e);
      }
    }
    return ev;
  }

  /** 新しいイベントを受け取る関数を登録する（解除用の関数を返す） */
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** t0 以降（t1 より前）のイベント */
  between(t0 = -Infinity, t1 = Infinity, name = null) {
    return this.events.filter((e) => e.t >= t0 && e.t < t1 && (!name || e.name === name));
  }

  last(name) {
    for (let i = this.events.length - 1; i >= 0; i--) if (!name || this.events[i].name === name) return this.events[i];
    return null;
  }

  clear() {
    this.events.length = 0;
  }
}

/** ?debug=1 で開いているか */
export const isDebug = () => flag('debug');

/**
 * デバッグ用の保存（?debug=1 のときだけ）。
 * サーバーが --debug-save で起動していなければ、サーバー側で断られる（何も保存されない）。
 * @returns {Promise<string|null>} 保存したファイルのパス（保存しなかったら null）
 */
export async function saveDebug(name, payload) {
  if (!isDebug()) return null;
  try {
    const res = await fetch(`/__debug/save?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn('デバッグ保存はできませんでした：', res.status, await res.text());
      return null;
    }
    const json = await res.json();
    console.info('デバッグ保存：', json.saved);
    return json.saved;
  } catch (e) {
    console.warn('デバッグ保存はできませんでした：', e);
    return null;
  }
}
