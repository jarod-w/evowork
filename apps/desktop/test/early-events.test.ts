/**
 * 早到的事件会不会丢（02 §8）。
 *
 * 这三条对应三种真实时序，不是三种写法：
 *   · 接线**之前**到 —— macOS 冷启动点分享链接，`open-url` 早于 `whenReady`
 *   · 接线**之后**到 —— 应用开着的时候点链接
 *   · 补发完**要清空** —— 否则第二次接线会重放一遍旧链接
 */
import { describe, expect, it } from 'vitest';

import { createEarlyBuffer } from '../src/main/early-events.js';

describe('早到的系统事件', () => {
  it('接线之前到的，接线时一条不少地补发出来', () => {
    const buffer = createEarlyBuffer<string>();
    buffer.push('evowork://share/shr_1');
    buffer.push('evowork://task/thr_2');

    const seen: string[] = [];
    buffer.connect((value) => seen.push(value));
    expect(seen, '早到的链接没有被补发 —— 用户那一侧就是「点了什么都没发生」').toEqual([
      'evowork://share/shr_1',
      'evowork://task/thr_2',
    ]);
  });

  it('接线之后到的直接走，不再进缓冲', () => {
    const buffer = createEarlyBuffer<string>();
    const seen: string[] = [];
    buffer.connect((value) => seen.push(value));
    buffer.push('evowork://task/thr_live');
    expect(seen).toEqual(['evowork://task/thr_live']);
  });

  it('**补发完要清空** —— 第二次接线不该再收到一遍旧的', () => {
    /*
     * 不清空的后果不是报错，是用户看到一次自己没点过的跳转。
     * 热重载、或者将来多接一个消费者，都会走到这里。
     */
    const buffer = createEarlyBuffer<string>();
    buffer.push('evowork://task/thr_old');
    buffer.connect(() => undefined);

    const second: string[] = [];
    buffer.connect((value) => second.push(value));
    expect(second, '旧链接被重放了一遍').toEqual([]);
  });
});
