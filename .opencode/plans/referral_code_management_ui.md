# Referral Code Management UI Plan

## Overview
Create a referral code management section in the Settings page where streamers can create, view, and delete their own referral codes. Codes will be displayed as "credit card" style UI elements with colors determined by hashing the code name.

## Current State

### Backend (Already Complete)
- Routes mounted at `/referrals`
- `GET /referrals/stats` - Returns referral stats (conversions, earnings, codes, balance)
- `GET /referrals/codes` - Lists user's referral codes with plan limits
- `POST /referrals/codes` - Creates a new referral code `{ code, label? }`
- `DELETE /referrals/codes/:codeId` - Soft-deletes a referral code

### Plan Limits (in `dimabot/src/utils/referral.ts`)
| Plan | Max Codes |
|------|-----------|
| Free | 1 |
| Premium | 5 |
| Pro | 15 |

### Frontend (Needs Implementation)
- No referral API methods in `DashboardApiService`
- No referral UI components
- No i18n keys for referral management

---

## Implementation Plan

### Phase 1: Backend Types & API Service (dimasite)

#### 1.1 Add Referral Models
**File:** `dimasite/src/app/features/dashboard/dashboard.models.ts`

Add interfaces:
```typescript
export interface ReferralCode {
  _id: string;
  code: string;
  label: string;
  stats: {
    conversions: number;
  };
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReferralStats {
  planType: 'FREE' | 'PREMIUM' | 'PRO';
  codeLimit: number;
  codesUsed: number;
  codesRemaining: number;
  codes: ReferralCode[];
  totalConversions: number;
  totalEarned: number;
  currentBalance: number;
}

export interface CreateReferralCodeRequest {
  code: string;
  label?: string;
}
```

#### 1.2 Add API Methods to DashboardApiService
**File:** `dimasite/src/app/services/dashboard-api.service.ts`

Add methods:
```typescript
getReferralStats(): Observable<ReferralStats>
getReferralCodes(): Observable<ReferralStats>
createReferralCode(code: string, label?: string): Observable<ReferralCode>
deleteReferralCode(codeId: string): Observable<void>
```

### Phase 2: UI Component

#### 2.1 Create Referral Card Component
**File:** `dimasite/src/app/features/settings/referral-code-card.component.ts`

A standalone component that displays a single referral code as a "credit card":
- Credit card visual design (rounded corners, gradient, card-like proportions)
- Hash-based deterministic color from code name
- Displays: code, label, conversions, created date, share link
- Copy share link button
- Delete button (owner only)

#### 2.2 Update Settings Page
**File:** `dimasite/src/app/features/settings/settings-page.component.ts`

Add referral section:
- Load referral stats on init
- Display plan tier limits (X/Y codes used)
- Grid of referral code cards
- Create new code form (if under limit)
- Owner-only controls

### Phase 3: Styling

#### 3.1 Add Credit Card Styles
**File:** `dimasite/src/styles.css`

Add styles for:
- `.referral-card` - Credit card container
- `.referral-card__gradient` - Hash-based color gradient background
- `.referral-card__chip` - Decorative chip element
- `.referral-card__code` - Large code display
- `.referral-card__stats` - Stats row
- `.referral-card__actions` - Button row

#### 3.2 Hash-Based Color Function
Implement a deterministic color generator in the card component:
```typescript
function getColorFromHash(code: string): { primary: string; secondary: string; gradient: string }
```

Use simple string hashing to generate HSL values for consistent, visually distinct colors per code.

### Phase 4: i18n

#### 4.1 Add Translation Keys
**Files:** 
- `dimasite/src/assets/i18n/en.json`
- `dimasite/src/assets/i18n/es.json`

Add under `settings.referrals`:
```json
{
  "settings": {
    "referrals": {
      "title": "Referral Codes",
      "subtitle": "Create custom referral codes to track where your viewers come from.",
      "codeLimit": "{{used}} of {{limit}} codes used",
      "createCode": "Create Code",
      "creating": "Creating...",
      "codeLabel": "Label (optional)",
      "codePlaceholder": "my_stream",
      "codeName": "Code",
      "codeNamePlaceholder": "code_name",
      "codeFormat": "1-16 alphanumeric characters or underscores",
      "shareLink": "Share Link",
      "copied": "Copied!",
      "copyFailed": "Failed to copy",
      "conversions": "{{count}} conversions",
      "noConversions": "No conversions yet",
      "deleteConfirm": "Delete this referral code?",
      "deleted": "Referral code deleted",
      "created": "Referral code created",
      "errors": {
        "limitReached": "You've reached your plan's code limit",
        "invalidFormat": "Code must be 1-16 alphanumeric characters or underscores",
        "codeTaken": "This code is already taken",
        "createFailed": "Failed to create referral code",
        "deleteFailed": "Failed to delete referral code",
        "loadFailed": "Failed to load referral codes"
      },
      "empty": "No referral codes yet. Create one to start tracking.",
      "upgradePrompt": "Upgrade to {{plan}} for up to {{limit}} codes"
    }
  }
}
```

---

## File Changes Summary

### New Files
| File | Description |
|------|-------------|
| `dimasite/src/app/features/settings/referral-code-card.component.ts` | Credit card styled referral code display |

### Modified Files
| File | Changes |
|------|---------|
| `dimasite/src/app/features/dashboard/dashboard.models.ts` | Add ReferralCode, ReferralStats interfaces |
| `dimasite/src/app/services/dashboard-api.service.ts` | Add referral API methods |
| `dimasite/src/app/features/settings/settings-page.component.ts` | Add referral section logic |
| `dimasite/src/app/features/settings/settings-page.component.html` | Add referral section template |
| `dimasite/src/styles.css` | Add credit card styles |
| `dimasite/src/assets/i18n/en.json` | Add referral translations |
| `dimasite/src/assets/i18n/es.json` | Add referral translations (ES) |

---

## Credit Card UI Design

```
┌─────────────────────────────────────────┐
│ ┌───┐                           ┌─────┐ │
│ │ █ │  streamer_code            │ COPY │ │
│ └───┘                           └─────┘ │
│                                         │
│ Label: My Twitch Stream                 │
│                                         │
│ Conversions: 42                         │
│ Earned: 4,200 tokens                    │
│ Created: Jan 15, 2025                   │
│                                         │
│ Share: https://domdimabot.com/r/code    │
│                           ┌────────────┐│
│                           │   DELETE   ││
│                           └────────────┘│
└─────────────────────────────────────────┘
```

### Color Hash Algorithm
```typescript
function hashToColor(code: string): { bg: string; gradient: string } {
  let hash = 0;
  for (let i = 0; i < code.length; i++) {
    hash = code.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  const hue = Math.abs(hash) % 360;
  const saturation = 60 + (Math.abs(hash >> 8) % 20); // 60-80%
  const lightness = 25 + (Math.abs(hash >> 16) % 15); // 25-40% (dark cards)
  
  return {
    bg: `hsl(${hue}, ${saturation}%, ${lightness}%)`,
    gradient: `linear-gradient(135deg, hsl(${hue}, ${saturation}%, ${lightness}%) 0%, hsl(${(hue + 30) % 360}, ${saturation}%, ${lightness - 5}%) 100%)`
  };
}
```

---

## Implementation Order

1. **Backend types** - Add interfaces to `dashboard.models.ts`
2. **API service** - Add methods to `DashboardApiService`
3. **i18n keys** - Add translations (EN + ES)
4. **Styles** - Add credit card CSS to `styles.css`
5. **Card component** - Create `referral-code-card.component.ts`
6. **Settings integration** - Update settings page with referral section

---

## Testing Checklist

- [ ] Free user can create 1 code, blocked from creating more
- [ ] Premium user can create up to 5 codes
- [ ] Pro user can create up to 15 codes
- [ ] Each code has consistent, unique color based on hash
- [ ] Copy share link works
- [ ] Delete requires confirmation
- [ ] Non-owner sees read-only view
- [ ] i18n works in both EN and ES
- [ ] Dark mode looks good
- [ ] Mobile responsive (cards stack on small screens)
