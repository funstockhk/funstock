import crypto from 'crypto';

export const SYNTHETIC_PASSWORD = 'synthetic-only-not-a-real-secret';
const SALT = 'aabbccddeeff00112233445566778899';

export function passwordHash(password) {
  const digest = crypto.createHmac('sha256', SALT).update(String(password)).digest('hex');
  return 'hmac-sha256$' + SALT + '$' + digest;
}

export function makeUser(jobId, role, status) {
  return {
    jobId: jobId,
    displayName: jobId === 'AC02-SYN-ADVISOR' ? '合成顾问' : (jobId === 'AC02-SYN-CLIENT' ? '合成客户' : jobId),
    role: role,
    status: status || '启用',
    passwordHash: passwordHash(SYNTHETIC_PASSWORD)
  };
}

export function emptyStore() {
  return {
    users: [
      makeUser('AC02-SYN-ADVISOR', '顾问', '启用'),
      makeUser('AC02-SYN-CLIENT', '客户', '启用'),
      makeUser('AC02-SYN-DISABLED', '顾问', '停用')
    ],
    config: {
      companyName: 'SYNTHETIC-AC02',
      companyNo: 'SYN',
      fx: [{ currency: 'HKD', rate: 1 }],
      accounts: [],
      waiverStandards: { salary: 15000, rent: 8000 },
      openingConfirmed: false
    },
    plans: [],
    proposals: [],
    files: [],
    pics: [],
    months: {},
    ledger: [],
    fourStatements: [],
    contracts: [],
    invoices: [],
    exports: [],
    logs: []
  };
}
