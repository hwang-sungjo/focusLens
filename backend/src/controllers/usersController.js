// src/controllers/usersController.js
const prisma = require('../models/prismaClient');
const { createError } = require('../middleware/errorHandler');

/** GET /api/users/:id/profile */
const getPublicProfile = async (req, res, next) => {
  try {
    const { id } = req.params;
    const profile = await prisma.user_profiles.findUnique({
      where: { user_id: id },
      select: { nickname: true, profile_image_url: true, bio: true },
    });
    if (!profile) return next(createError('프로필을 찾을 수 없습니다.', 404));
    return res.status(200).json({ success: true, data: { profile }, error: '' });
  } catch (err) {
    next(err);
  }
};

/** PATCH /api/users/me/profile */
const updateMyProfile = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { nickname, bio, profile_image_url } = req.body;

    const profile = await prisma.user_profiles.update({
      where: { user_id: userId },
      data: {
        ...(nickname !== undefined && { nickname }),
        ...(bio !== undefined && { bio }),
        ...(profile_image_url !== undefined && { profile_image_url }),
      },
      select: { nickname: true, bio: true, profile_image_url: true, updated_at: true },
    });

    return res.status(200).json({ success: true, data: { profile }, error: '' });
  } catch (err) {
    next(err);
  }
};

/** GET /api/users/me/privacy */
const getPrivacySettings = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const settings = await prisma.user_privacy_settings.findUnique({
      where: { user_id: userId },
      select: {
        default_session_scope: true,
        score_visibility: true,
        study_time_visibility: true,
        group_data_sharing: true,
        ranking_participation: true,
      },
    });
    if (!settings) return next(createError('프라이버시 설정을 찾을 수 없습니다.', 404));
    return res.status(200).json({ success: true, data: { settings }, error: '' });
  } catch (err) {
    next(err);
  }
};

/** PATCH /api/users/me/privacy */
const updatePrivacySettings = async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { default_session_scope, score_visibility, study_time_visibility, group_data_sharing, ranking_participation } = req.body;

    const settings = await prisma.user_privacy_settings.update({
      where: { user_id: userId },
      data: {
        ...(default_session_scope !== undefined && { default_session_scope }),
        ...(score_visibility !== undefined && { score_visibility }),
        ...(study_time_visibility !== undefined && { study_time_visibility }),
        ...(group_data_sharing !== undefined && { group_data_sharing }),
        ...(ranking_participation !== undefined && { ranking_participation }),
      },
    });

    return res.status(200).json({ success: true, data: { settings }, error: '' });
  } catch (err) {
    next(err);
  }
};

module.exports = { getPublicProfile, updateMyProfile, getPrivacySettings, updatePrivacySettings };
