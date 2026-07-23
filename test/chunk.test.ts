import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkFaq, chunkManual } from '../src/chunk.js';

test('chunkFaq: one chunk per ## section, preamble dropped', () => {
  const md = [
    '# DramaClaw 知识库',              // H1 title — must be skipped
    '',
    '> 这是给作者看的说明，不是知识。',  // blockquote preamble — must be skipped
    '',
    '## 关于产品',
    '- DramaClaw 是一个平台。',
    '',
    '## 充值',
    '| 档位 | 到账 |',
    '| --- | --- |',
    '| 99元 | 2215积分 |',
  ].join('\n');

  const chunks = chunkFaq(md);

  assert.equal(chunks.length, 2, 'exactly two ## sections');
  assert.ok(chunks[0].startsWith('## 关于产品'), 'chunk keeps its ## heading');
  assert.ok(!chunks.join('\n').includes('给作者看'), 'blockquote preamble is dropped');
  assert.ok(!chunks.join('\n').includes('# DramaClaw 知识库'), 'H1 title is dropped');
  // The pricing table must survive intact — the exact number the bot quotes.
  assert.ok(chunks[1].includes('| 99元 | 2215积分 |'), 'table row not split');
});

test('chunkManual: splits on 小节, keeps chapter path, ignores list items', () => {
  const text = [
    '第九章：虾导、虾格、虾条',
    '本章介绍三个工具。',            // chapter intro → its own chunk keyed by chapter
    '9.1 虾导：AI 导演助手',
    '虾导可以查询进度。',
    '1. 进入虾导。',                // numbered list item — NOT a new 小节
    '2. 查看任务。',
    '9.2 虾格：风格模板',
    '虾格用于管理风格。',
  ].join('\n');

  const chunks = chunkManual(text);

  assert.equal(chunks.length, 3, 'chapter-intro + two 小节');
  assert.equal(chunks[0].section, '第九章：虾导、虾格、虾条');
  assert.equal(chunks[1].section, '第九章：虾导、虾格、虾条 / 9.1 虾导：AI 导演助手');
  assert.ok(chunks[1].content.includes('1. 进入虾导。'), 'list item stays inside its 小节');
  assert.equal(chunks[2].section, '第九章：虾导、虾格、虾条 / 9.2 虾格：风格模板');
});
