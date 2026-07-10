// prisma/seed.js
// 테스트 시드 데이터 — Phase 2 환경 구축용
// 실행 위치: focusLens/backend/ 디렉토리에서
//   node ../prisma/seed.js
//   또는 루트에서: npm run db:seed
'use strict';

const path = require('path');
// bcrypt와 PrismaClient는 backend/node_modules에 설치되어 있으므로 명시적 경로 지정
const backendModules = path.resolve(__dirname, '../backend/node_modules');
const { PrismaClient } = require(path.join(backendModules, '@prisma/client'));
const bcrypt = require(path.join(backendModules, 'bcryptjs'));


const prisma = new PrismaClient();
const SALT_ROUNDS = 10;

async function main() {
  console.log('🌱 Seeding start...');

  // ── 1. 테스트 유저 3명 생성 ────────────────────────────────────────
  const [pwA, pwB, pwAdmin] = await Promise.all([
    bcrypt.hash('password_a123!', SALT_ROUNDS),
    bcrypt.hash('password_b123!', SALT_ROUNDS),
    bcrypt.hash('password_admin123!', SALT_ROUNDS),
  ]);

  // upsert로 중복 실행해도 안전
  const userA = await prisma.users.upsert({
    where: { email: 'user_a@focuslens.dev' },
    update: {},
    create: {
      email: 'user_a@focuslens.dev',
      password_hash: pwA,
      name: '유저A',
      role: 'USER',
      status: 'ACTIVE',
      // user_profiles 자동 생성
      user_profile: {
        create: {
          nickname: 'user_a',
          bio: '테스트 유저 A입니다.',
        },
      },
      // user_privacy_settings 기본값 생성
      // default_session_scope=PRIVATE, ranking_participation=false (ERD 설계 원칙)
      user_privacy_settings: {
        create: {
          default_session_scope: 'PRIVATE',
          score_visibility: 'PRIVATE',
          study_time_visibility: 'PRIVATE',
          group_data_sharing: true,
          ranking_participation: false,
        },
      },
    },
  });

  const userB = await prisma.users.upsert({
    where: { email: 'user_b@focuslens.dev' },
    update: {},
    create: {
      email: 'user_b@focuslens.dev',
      password_hash: pwB,
      name: '유저B',
      role: 'USER',
      status: 'ACTIVE',
      user_profile: {
        create: {
          nickname: 'user_b',
          bio: '테스트 유저 B입니다.',
        },
      },
      user_privacy_settings: {
        create: {
          default_session_scope: 'PRIVATE',
          score_visibility: 'PRIVATE',
          study_time_visibility: 'PRIVATE',
          group_data_sharing: true,
          ranking_participation: false,
        },
      },
    },
  });

  const adminUser = await prisma.users.upsert({
    where: { email: 'admin@focuslens.dev' },
    update: {},
    create: {
      email: 'admin@focuslens.dev',
      password_hash: pwAdmin,
      name: '관리자',
      role: 'ADMIN',
      status: 'ACTIVE',
      user_profile: {
        create: {
          nickname: 'admin',
          bio: 'FocusLens 관리자입니다.',
        },
      },
      user_privacy_settings: {
        create: {
          default_session_scope: 'PRIVATE',
          score_visibility: 'PRIVATE',
          study_time_visibility: 'PRIVATE',
          group_data_sharing: false,
          ranking_participation: false,
        },
      },
    },
  });

  console.log(`✅ Users: ${userA.email}, ${userB.email}, ${adminUser.email}`);

  // ── 2. 테스트 그룹 생성 (admin이 OWNER, user_a가 MEMBER) ──────────
  // 그룹 권한은 group_members.group_role 기준 (ERD 원칙)
  // groups.created_by_user_id는 이력 보존용
  const existingGroup = await prisma.groups.findFirst({
    where: { name: 'FocusLens 스터디 그룹', created_by_user_id: adminUser.id },
  });

  let group;
  if (!existingGroup) {
    group = await prisma.groups.create({
      data: {
        created_by_user_id: adminUser.id,
        name: 'FocusLens 스터디 그룹',
        description: '집중도 향상을 목표로 하는 테스트 스터디 그룹입니다.',
        group_type: 'STUDY',
        visibility: 'PUBLIC',
        status: 'ACTIVE',
        // admin → OWNER로 자동 등록
        group_members: {
          create: [
            {
              user_id: adminUser.id,
              group_role: 'OWNER',
              status: 'ACTIVE',
              joined_at: new Date(),
            },
            {
              user_id: userA.id,
              group_role: 'MEMBER',
              status: 'ACTIVE',
              joined_at: new Date(),
            },
          ],
        },
      },
    });
    console.log(`✅ Group: "${group.name}" 생성 완료`);
  } else {
    group = existingGroup;
    console.log(`⏭️  Group: "${group.name}" 이미 존재 — skip`);
  }

  // ── 3. user_a ↔ user_b 친구 관계 설정 ────────────────────────────
  // UNIQUE(user_a_id, user_b_id), CHECK(user_a_id <> user_b_id)
  // user_a_id < user_b_id 순서로 정렬하여 중복 방지 (컨트롤러 로직과 동일)
  const [aId, bId] = [userA.id, userB.id].sort();

  // 먼저 user_connection_requests 레코드 생성 (이력 보존)
  const existingRequest = await prisma.user_connection_requests.findFirst({
    where: {
      OR: [
        { requester_user_id: userA.id, receiver_user_id: userB.id },
        { requester_user_id: userB.id, receiver_user_id: userA.id },
      ],
    },
  });

  if (!existingRequest) {
    await prisma.user_connection_requests.create({
      data: {
        requester_user_id: userA.id,
        receiver_user_id: userB.id,
        status: 'ACCEPTED',
      },
    });
  }

  // user_connections — 실제 친구 관계
  await prisma.user_connections.upsert({
    where: { user_a_id_user_b_id: { user_a_id: aId, user_b_id: bId } },
    update: {},
    create: { user_a_id: aId, user_b_id: bId },
  });

  console.log(`✅ Connection: ${userA.email} ↔ ${userB.email} 친구 관계 설정 완료`);

  // ── 완료 요약 ────────────────────────────────────────────────────
  console.log('\n🌱 Seed 완료!');
  console.log('─'.repeat(50));
  console.log('테스트 계정 정보:');
  console.log('  user_a  : user_a@focuslens.dev  / password_a123!');
  console.log('  user_b  : user_b@focuslens.dev  / password_b123!');
  console.log('  admin   : admin@focuslens.dev   / password_admin123!');
  console.log('─'.repeat(50));
}

main()
  .catch((e) => {
    console.error('❌ Seed 오류:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
