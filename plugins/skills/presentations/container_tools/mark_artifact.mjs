#!/usr/bin/env node
/**
 * 四个技能共用一份实现（`plugins/skills/_shared/mark_artifact.mjs`），
 * 这里只把技能名传进去。SKILL.md 里的调用路径与参数因此保持不变。
 */
import { runMarkArtifact } from '../../_shared/mark_artifact.mjs';

runMarkArtifact('presentations');
