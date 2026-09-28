'use strict';

const { fail } = require('./v2-core');

const RISKY_CODE = 87014;

function codeOf(value) {
  const code = value && (value.errCode !== undefined ? value.errCode : value.errcode);
  return Number(code || 0);
}

function suggestOf(value) {
  return String(value && value.result && value.result.suggest || value && value.suggest || '').toLowerCase();
}

function createSecurity(cloud) {
  async function checkText(content, openid, scene = 4) {
    const value = String(content || '').trim();
    if (!value) return;

    try {
      if (!cloud.openapi || !cloud.openapi.security || typeof cloud.openapi.security.msgSecCheck !== 'function') {
        fail('CONTENT_CHECK_FAILED', '内容安全检查暂时不可用，请稍后重试');
      }
      const result = await cloud.openapi.security.msgSecCheck({
        content: value,
        version: 2,
        scene,
        openid,
      });
      const suggest = suggestOf(result);
      if (codeOf(result) === RISKY_CODE || (suggest && suggest !== 'pass')) {
        fail('CONTENT_RISKY', '内容可能包含不适合发布的信息，请调整后再试');
      }
    } catch (error) {
      if (error && error.isBusiness === true) throw error;
      if (codeOf(error) === RISKY_CODE || suggestOf(error) === 'risky') {
        fail('CONTENT_RISKY', '内容可能包含不适合发布的信息，请调整后再试');
      }
      fail('CONTENT_CHECK_FAILED', '内容安全检查暂时不可用，请稍后重试');
    }
  }

  async function checkImage(buffer, extension) {
    if (!Buffer.isBuffer(buffer) || buffer.length <= 0 || buffer.length > 1024 * 1024) {
      fail('CONTENT_IMAGE_REVIEW_INVALID', '图片审核副本不符合要求，请重新选择图片');
    }
    const contentTypes = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
    };
    const contentType = contentTypes[String(extension || '').toLowerCase()];
    if (!contentType) fail('CONTENT_IMAGE_REVIEW_INVALID', '图片审核副本格式不支持');

    try {
      if (!cloud.openapi || !cloud.openapi.security || typeof cloud.openapi.security.imgSecCheck !== 'function') {
        fail('CONTENT_CHECK_FAILED', '图片安全检查暂时不可用，请稍后重试');
      }
      const result = await cloud.openapi.security.imgSecCheck({
        media: {
          contentType,
          value: buffer,
        },
      });
      if (codeOf(result) === RISKY_CODE) {
        fail('CONTENT_RISKY', '图片可能包含不适合发布的内容，请更换后再试');
      }
    } catch (error) {
      if (error && error.isBusiness === true) throw error;
      if (codeOf(error) === RISKY_CODE) {
        fail('CONTENT_RISKY', '图片可能包含不适合发布的内容，请更换后再试');
      }
      fail('CONTENT_CHECK_FAILED', '图片安全检查暂时不可用，请稍后重试');
    }
  }

  async function checkFields(openid, scene, values) {
    const content = (Array.isArray(values) ? values : [values])
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .join('\n');
    if (content) await checkText(content, openid, scene);
  }

  return { checkText, checkFields, checkImage };
}

module.exports = { createSecurity };
