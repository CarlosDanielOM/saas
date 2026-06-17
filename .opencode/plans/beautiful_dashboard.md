# Beautiful Dashboard Plan

## Overview

Redesign the dashboard with a modern 3-row layout:
- **Row 1**: 5 KPI cards (avg/hour per stream, avg viewers, bits 30d, donations 30d, total follows 30d)
- **Row 2**: 65/35 split - Multi-line trend chart (65%) + Goals section (35%)
- **Row 3**: Stream history table (last 30 days, recent to oldest)

## Data Availability

### Already Available from Backend (`/dashboard/:channelID/bootstrap`)

From `DashboardKpis`:
- `averageViewers30d` ✓
- `totalDonations30d` ✓
- `totalFollows30d` ✓
- `activeSubs` ✓
- `streamUptimeMinutes` ✓ (for current stream)

From `DashboardAnalyticsResult.kpis` (backend `getDashboardAnalytics`):
- `averageHoursPerStream` ✓
- `totalBits` ✓
- `totalDonations` ✓
- `activeFollows` ✓ (total follows in period)
- `activeSubs` ✓

From `streamHistory` (per stream):
- `date`, `viewers`, `hours`, `bits`, `donations`, `follows`, `subs`

### Follow/Sub Total Counts

Need to query these separately:
- Total followers: `FollowRelationshipLedgerSchema.countDocuments({ followed_id: channelID, status: 'active' })`
- Total subs: `StreamSubscriptionLedgerSchema.countDocuments({ streamer_id: channelID, status: 'active' })`

**Note**: Goals are NOT implemented. Using 1,000 placeholder for both.

---

## Implementation Plan

### Phase 1: Backend Updates

#### 1.1 Update Dashboard Bootstrap Endpoint

**File**: `dimabot/src/server/routes/dashboard.route.ts`

Add follower/sub total counts to bootstrap response:

```typescript
// In GET /:channelID/bootstrap, after existing data collection:

import { FollowRelationshipLedgerSchema } from '../../schemas/follow_relationship_ledger.schema.js';
import { StreamSubscriptionLedgerSchema } from '../../schemas/stream_subscription_ledger.schema.js';

const totalFollowers = await FollowRelationshipLedgerSchema.countDocuments({
    followed_id: channelIdStr,
    status: 'active'
});

const totalSubs = await StreamSubscriptionLedgerSchema.countDocuments({
    streamer_id: channelIdStr,
    status: 'active'
});

// Add to response data:
const totalFollows30d = analytics.kpis.activeFollows;

return res.status(200).json({
    error: false,
    message: 'Dashboard bootstrap fetched successfully',
    status: 200,
    data: {
        // ... existing fields
        totalFollowers,
        totalSubs,
        totalFollows30d,
        monthlyGoals: {
            followersGoal: 1000,
            followersCurrent: totalFollowers,
            subsGoal: 1000,
            subsCurrent: totalSubs
        }
    }
});
```

#### 1.2 Update Frontend Model

**File**: `dimasite/src/app/models/dashboard.model.ts`

Update `DashboardBootstrapData` interface:

```typescript
export interface DashboardBootstrapData {
    channel: DashboardChannel;
    isLive: boolean;
    liveStream: TwitchStream | null;
    kpis: DashboardKpis;
    trend: DashboardTrendPoint[];
    streamHistory: DashboardStreamHistoryPoint[];
    totalFollowers: number;
    totalSubs: number;
    totalFollows30d: number;
    monthlyGoals: {
        followersGoal: number;
        followersCurrent: number;
        subsGoal: number;
        subsCurrent: number;
    };
}
```

---

### Phase 2: Frontend Component Updates

#### 2.1 Update Dashboard Component TypeScript

**File**: `dimasite/src/app/features/dashboard/dashboard.component.ts`

Add new computed signals and chart configuration:

```typescript
// Add new computed signals
readonly totalFollowers = computed(() => this.bootstrap()?.totalFollowers ?? 0);
readonly totalSubs = computed(() => this.bootstrap()?.totalSubs ?? 0);
readonly totalFollows30d = computed(() => this.bootstrap()?.totalFollows30d ?? 0);
readonly averageHoursPerStream = computed(() => this.bootstrap()?.kpis.averageHoursPerStream ?? 0);
readonly totalBits30d = computed(() => this.bootstrap()?.kpis.totalBits ?? 0);
readonly totalDonations30d = computed(() => this.bootstrap()?.kpis.totalDonations ?? 0);

readonly monthlyGoals = computed(() => this.bootstrap()?.monthlyGoals ?? {
    followersGoal: 1000,
    followersCurrent: 0,
    subsGoal: 1000,
    subsCurrent: 0
});

// Replace viewersLineChartOption and activityBarChartOption with:
readonly multiLineChartOption = signal<EChartsOption>({});

// Update buildCharts method to build multi-line chart
private buildCharts(trend: DashboardTrendPoint[], history: DashboardStreamHistoryPoint[]): void {
    const labels = trend.map((point) => this.formatDate(point.date));

    // Aggregate history by day for all metrics
    const metricsByDay = new Map<string, {
        bits: number;
        subs: number;
        hours: number;
        viewers: number;
        follows: number;
    }>();

    for (const point of history) {
        const dayKey = toUtcDayKey(new Date(point.date));
        const existing = metricsByDay.get(dayKey) || { bits: 0, subs: 0, hours: 0, viewers: 0, follows: 0 };
        existing.bits += point.bits;
        existing.subs += point.subs;
        existing.hours += point.hours;
        existing.viewers += point.viewers;
        existing.follows += point.follows;
        metricsByDay.set(dayKey, existing);
    }

    const days = Array.from(metricsByDay.keys()).sort();
    const dayLabels = days.map((day) => this.formatDayLabel(day));

    const bits = days.map((day) => metricsByDay.get(day)?.bits ?? 0);
    const subs = days.map((day) => metricsByDay.get(day)?.subs ?? 0);
    const hours = days.map((day) => metricsByDay.get(day)?.hours ?? 0);
    const viewers = days.map((day) => metricsByDay.get(day)?.viewers ?? 0);
    const follows = days.map((day) => metricsByDay.get(day)?.follows ?? 0);

    const lineBase = this.chartConfig.getLineChartBase();

    this.multiLineChartOption.set({
        ...lineBase,
        xAxis: {
            ...lineBase.xAxis,
            data: dayLabels
        },
        yAxis: {
            ...lineBase.yAxis,
            type: 'value',
            name: 'Count',
            nameLocation: 'middle',
            nameGap: 30
        },
        legend: {
            data: ['Bits', 'Subs', 'Hours', 'Viewers', 'Follows'],
            top: 0,
            textStyle: { color: lineBase.textStyle?.color }
        },
        tooltip: {
            ...lineBase.tooltip,
            formatter: (params: any) => {
                if (!Array.isArray(params)) return '';
                let result = `<div style="font-weight:bold;margin-bottom:4px;">${params[0].axisValue}</div>`;
                params.forEach((p) => {
                    result += `<div style="margin:2px 0;">
                        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;background:${p.color};"></span>
                        ${p.seriesName}: <strong>${p.value.toLocaleString()}</strong>
                    </div>`;
                });
                return result;
            }
        },
        series: [
            {
                name: 'Bits',
                type: 'line',
                smooth: true,
                symbol: 'circle',
                symbolSize: 6,
                data: bits,
                lineStyle: { width: 2, color: '#f59e0b' },
                itemStyle: { color: '#f59e0b' }
            },
            {
                name: 'Subs',
                type: 'line',
                smooth: true,
                symbol: 'circle',
                symbolSize: 6,
                data: subs,
                lineStyle: { width: 2, color: '#10b981' },
                itemStyle: { color: '#10b981' }
            },
            {
                name: 'Hours',
                type: 'line',
                smooth: true,
                symbol: 'circle',
                symbolSize: 6,
                data: hours,
                lineStyle: { width: 2, color: '#3b82f6' },
                itemStyle: { color: '#3b82f6' }
            },
            {
                name: 'Viewers',
                type: 'line',
                smooth: true,
                symbol: 'circle',
                symbolSize: 6,
                data: viewers,
                lineStyle: { width: 2, color: '#8b5cf6' },
                itemStyle: { color: '#8b5cf6' }
            },
            {
                name: 'Follows',
                type: 'line',
                smooth: true,
                symbol: 'circle',
                symbolSize: 6,
                data: follows,
                lineStyle: { width: 2, color: '#ec4899' },
                itemStyle: { color: '#ec4899' }
            }
        ]
    });
}

// Add helper method for day labels
private formatDayLabel(dayKey: string): string {
    const [year, month, day] = dayKey.split('-');
    const date = new Date(`${year}-${month}-${day}`);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Add helper for UTC day key (reuse from backend)
private toUtcDayKey(date: Date): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
```

---

#### 2.2 Update Dashboard Component Template

**File**: `dimasite/src/app/features/dashboard/dashboard.component.html`

Replace entire template with new 3-row layout:

```html
<section class="dashboard-shell" aria-live="polite">
  <header class="dashboard-header">
    <div>
      <p class="dashboard-eyebrow">{{ t('dashboard.pageLabel') }}</p>
      <h1 class="dashboard-title">{{ t('dashboard.title') }}</h1>
      <p class="dashboard-subtitle">{{ t('dashboard.subtitle') }}</p>
    </div>

    <div class="dashboard-status" [class.dashboard-status--offline]="connectionStatus() === 'disconnected'">
      <span class="dashboard-status__dot" aria-hidden="true"></span>
      <span>{{ t('dashboard.connection.' + connectionStatus()) }}</span>
    </div>
  </header>

  @if (errorMessage()) {
    <div class="dashboard-error" role="alert">
      <p>{{ errorMessage() }}</p>
    </div>
  } @else if (loading() && !bootstrap()) {
    <div class="dashboard-loading" role="status">
      <div class="dashboard-spinner" aria-hidden="true"></div>
      <p>{{ t('dashboard.loading') }}</p>
    </div>
  } @else if (!bootstrap()) {
    <div class="dashboard-empty">
      <p>{{ t('dashboard.empty') }}</p>
    </div>
  } @else {
    <!-- ROW 1: KPI Cards -->
    <section class="dashboard-kpis" aria-label="Key metrics">
      <article class="dashboard-kpi-card">
        <p class="dashboard-kpi-card__label">{{ t('dashboard.kpis.avgHoursPerStream') }}</p>
        <p class="dashboard-kpi-card__value">{{ averageHoursPerStream().toFixed(1) }}h</p>
      </article>

      <article class="dashboard-kpi-card">
        <p class="dashboard-kpi-card__label">{{ t('dashboard.kpis.averageViewers30d') }}</p>
        <p class="dashboard-kpi-card__value" [countUp]="kpis().averageViewers30d">0</p>
      </article>

      <article class="dashboard-kpi-card dashboard-kpi-card--bits">
        <p class="dashboard-kpi-card__label">{{ t('dashboard.kpis.bits30d') }}</p>
        <p class="dashboard-kpi-card__value" [countUp]="totalBits30d()">0</p>
      </article>

      <article class="dashboard-kpi-card dashboard-kpi-card--donations">
        <p class="dashboard-kpi-card__label">{{ t('dashboard.kpis.donations30d') }}</p>
        <p class="dashboard-kpi-card__value">${{ totalDonations30d().toFixed(2) }}</p>
      </article>

      <article class="dashboard-kpi-card dashboard-kpi-card--follows">
        <p class="dashboard-kpi-card__label">{{ t('dashboard.kpis.totalFollows30d') }}</p>
        <p class="dashboard-kpi-card__value" [countUp]="totalFollows30d()">0</p>
      </article>
    </section>

    <!-- ROW 2: 65/35 Split -->
    <section class="dashboard-middle-row">
      <!-- Left 65%: Multi-line chart -->
      <article class="dashboard-trends-section" aria-label="Performance trends">
        <div class="dashboard-trends-header">
          <h2>{{ t('dashboard.charts.title') }}</h2>
          <div class="dashboard-ranges" role="tablist" [attr.aria-label]="t('dashboard.timeRange.title')">
            @for (range of timeRanges; track range) {
              <button
                type="button"
                class="dashboard-range-button"
                [class.dashboard-range-button--active]="selectedTimeRange() === range"
                (click)="selectTimeRange(range)"
              >
                {{ timeRangeLabel(range) }}
              </button>
            }
          </div>
        </div>
        <div echarts class="dashboard-multi-line-chart" [options]="multiLineChartOption()"></div>
      </article>

      <!-- Right 35%: Goals -->
      <article class="dashboard-goals-section" aria-label="Monthly goals">
        <h2>{{ t('dashboard.goals.title') }}</h2>

        <div class="dashboard-goal-item">
          <div class="dashboard-goal-header">
            <div>
              <p class="dashboard-goal-label">{{ t('dashboard.goals.followers') }}</p>
              <p class="dashboard-goal-count">
                {{ monthlyGoals().followersCurrent.toLocaleString() }} / {{ monthlyGoals().followersGoal.toLocaleString() }}
              </p>
            </div>
            <span class="dashboard-goal-percent">
              {{ Math.round((monthlyGoals().followersCurrent / monthlyGoals().followersGoal) * 100) }}%
            </span>
          </div>
          <div class="dashboard-progress-bar">
            <div
              class="dashboard-progress-fill"
              style="width: {{ Math.min(100, (monthlyGoals().followersCurrent / monthlyGoals().followersGoal) * 100) }}%"
            ></div>
          </div>
        </div>

        <div class="dashboard-goal-item">
          <div class="dashboard-goal-header">
            <div>
              <p class="dashboard-goal-label">{{ t('dashboard.goals.subs') }}</p>
              <p class="dashboard-goal-count">
                {{ monthlyGoals().subsCurrent.toLocaleString() }} / {{ monthlyGoals().subsGoal.toLocaleString() }}
              </p>
            </div>
            <span class="dashboard-goal-percent">
              {{ Math.round((monthlyGoals().subsCurrent / monthlyGoals().subsGoal) * 100) }}%
            </span>
          </div>
          <div class="dashboard-progress-bar">
            <div
              class="dashboard-progress-fill dashboard-progress-fill--subs"
              style="width: {{ Math.min(100, (monthlyGoals().subsCurrent / monthlyGoals().subsGoal) * 100) }}%"
            ></div>
          </div>
        </div>
      </article>
    </section>

    <!-- ROW 3: Stream History Table -->
    <section class="dashboard-history-section" aria-label="Stream history">
      <h2>{{ t('dashboard.history.title') }}</h2>

      <div class="dashboard-table-container">
        <table class="dashboard-table">
          <thead>
            <tr>
              <th>{{ t('dashboard.history.date') }}</th>
              <th>{{ t('dashboard.history.duration') }}</th>
              <th>{{ t('dashboard.history.viewers') }}</th>
              <th>{{ t('dashboard.history.bits') }}</th>
              <th>{{ t('dashboard.history.donations') }}</th>
              <th>{{ t('dashboard.history.follows') }}</th>
              <th>{{ t('dashboard.history.subs') }}</th>
            </tr>
          </thead>
          <tbody>
            @for (stream of streamHistoryData(); track stream.date) {
              <tr>
                <td>{{ formatDate(stream.date) }}</td>
                <td>{{ formatHours(stream.hours) }}</td>
                <td>{{ stream.viewers.toLocaleString() }}</td>
                <td>{{ stream.bits.toLocaleString() }}</td>
                <td>${{ stream.donations.toFixed(2) }}</td>
                <td>{{ stream.follows.toLocaleString() }}</td>
                <td>{{ stream.subs.toLocaleString() }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="7" class="dashboard-table-empty">{{ t('dashboard.history.noStreams') }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </section>
  }
</section>
```

Add helper method in component:

```typescript
formatHours(hours: number): string {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
```

---

#### 2.3 Update Translations

**File**: `dimasite/src/assets/i18n/en.json`

Update dashboard section:

```json
"dashboard": {
    "pageLabel": "Control Center",
    "title": "Channel Dashboard",
    "subtitle": "Real-time performance and audience trends from your stream analytics.",
    "loading": "Loading your dashboard...",
    "empty": "No dashboard data is available yet.",
    "connection": {
        "connected": "Connected",
        "connecting": "Connecting",
        "disconnected": "Disconnected"
    },
    "errors": {
        "missingChannel": "A streamer channel is required to load the dashboard.",
        "loadFailed": "Unable to load dashboard data right now."
    },
    "kpis": {
        "avgHoursPerStream": "Avg Hours/Stream",
        "averageViewers30d": "Average Viewers (30d)",
        "bits30d": "Bits (30d)",
        "donations30d": "Donations (30d)",
        "totalFollows30d": "Total Follows (30d)",
        "activeViewers": "Active Viewers",
        "peakViewers30d": "Peak Viewers (30d)",
        "totalCommands": "Commands Executed (30d)",
        "messagesReceived": "Messages Received (30d)",
        "streamUptime": "Stream Uptime"
    },
    "charts": {
        "title": "Performance Trends"
    },
    "timeRange": {
        "title": "Choose time range",
        "7d": "7d",
        "30d": "30d",
        "90d": "90d",
        "all": "All"
    },
    "goals": {
        "title": "Monthly Goals",
        "followers": "Followers",
        "subs": "Subscribers"
    },
    "history": {
        "title": "Stream History (30d)",
        "date": "Date",
        "duration": "Duration",
        "viewers": "Viewers",
        "bits": "Bits",
        "donations": "Donations",
        "follows": "Follows",
        "subs": "Subs",
        "noStreams": "No streams in the last 30 days"
    },
    "live": {
        "title": "Live Status",
        "liveNow": "Live Now",
        "offline": "Offline",
        "offlineDescription": "No active stream detected for this channel.",
        "viewers": "viewers"
    }
}
```

**File**: `dimasite/src/assets/i18n/es.json`

Add matching Spanish translations.

---

#### 2.4 Update Dashboard Styles

**File**: `dimasite/src/styles.css`

Replace/update dashboard CSS (lines ~1400-1649):

```css
/* ========== DASHBOARD LAYOUT ========== */

.dashboard-shell {
  max-width: 78rem;
  margin: 0 auto;
  display: grid;
  gap: 1.25rem;
}

.dashboard-header {
  border: 1px solid color-mix(in srgb, var(--ring) 30%, transparent);
  border-radius: 1rem;
  padding: 1.2rem;
  background: color-mix(in srgb, var(--surface) 86%, transparent);
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
}

.dashboard-eyebrow {
  margin: 0;
  font-size: 0.72rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-soft);
}

.dashboard-title {
  margin: 0.35rem 0 0;
  font-family: 'Sora', 'Space Grotesk', sans-serif;
  font-size: clamp(1.35rem, 2.5vw, 2rem);
}

.dashboard-subtitle {
  margin: 0.45rem 0 0;
  color: var(--text-soft);
  max-width: 44rem;
}

.dashboard-status {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  border-radius: 9999px;
  padding: 0.35rem 0.65rem;
  font-size: 0.75rem;
  font-weight: 700;
  background: rgba(34, 197, 94, 0.15);
  color: #166534;
}

.dashboard-status--offline {
  background: rgba(239, 68, 68, 0.14);
  color: #b91c1c;
}

.dashboard-status__dot {
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 9999px;
  background: currentColor;
}

.dashboard-loading,
.dashboard-empty,
.dashboard-error {
  border: 1px solid color-mix(in srgb, var(--ring) 24%, transparent);
  border-radius: 1rem;
  background: color-mix(in srgb, var(--surface) 90%, transparent);
  padding: 2rem 1rem;
  text-align: center;
}

.dashboard-error {
  border-color: rgba(239, 68, 68, 0.34);
}

.dashboard-spinner {
  width: 2rem;
  height: 2rem;
  border-radius: 9999px;
  border: 3px solid color-mix(in srgb, var(--ring) 25%, transparent);
  border-top-color: color-mix(in srgb, var(--ring) 80%, #4338ca);
  margin: 0 auto;
  animation: spin 0.85s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ========== ROW 1: KPI CARDS ========== */

.dashboard-kpis {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 0.75rem;
}

.dashboard-kpi-card {
  border-radius: 0.95rem;
  border: 1px solid color-mix(in srgb, var(--ring) 24%, transparent);
  background: color-mix(in srgb, var(--surface) 90%, transparent);
  padding: 0.95rem;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.dashboard-kpi-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px color-mix(in srgb, var(--ring) 20%, transparent);
}

.dashboard-kpi-card--bits {
  border-color: rgba(245, 158, 11, 0.3);
  background: color-mix(in srgb, #f59e0b 8%, var(--surface) 90%);
}

.dashboard-kpi-card--donations {
  border-color: rgba(16, 185, 129, 0.3);
  background: color-mix(in srgb, #10b981 8%, var(--surface) 90%);
}

.dashboard-kpi-card--follows {
  border-color: rgba(236, 72, 153, 0.3);
  background: color-mix(in srgb, #ec4899 8%, var(--surface) 90%);
}

.dashboard-kpi-card__label {
  margin: 0;
  font-size: 0.72rem;
  color: var(--text-soft);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 600;
}

.dashboard-kpi-card__value {
  margin: 0.4rem 0 0;
  font-size: clamp(1.35rem, 2.5vw, 1.75rem);
  font-weight: 800;
  letter-spacing: -0.03em;
}

/* ========== ROW 2: 65/35 SPLIT ========== */

.dashboard-middle-row {
  display: grid;
  grid-template-columns: 1.5fr 1fr;
  gap: 1rem;
}

.dashboard-trends-section {
  border: 1px solid color-mix(in srgb, var(--ring) 24%, transparent);
  border-radius: 1rem;
  background: color-mix(in srgb, var(--surface) 90%, transparent);
  padding: 1rem;
  display: flex;
  flex-direction: column;
}

.dashboard-trends-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.7rem;
  margin-bottom: 0.5rem;
  flex-wrap: wrap;
}

.dashboard-trends-header h2 {
  margin: 0;
  font-family: 'Sora', 'Space Grotesk', sans-serif;
  font-size: 1.1rem;
}

.dashboard-ranges {
  display: flex;
  gap: 0.35rem;
}

.dashboard-range-button {
  border: 1px solid color-mix(in srgb, var(--ring) 30%, transparent);
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  color: inherit;
  border-radius: 9999px;
  padding: 0.28rem 0.55rem;
  font-size: 0.72rem;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.2s ease;
}

.dashboard-range-button:hover {
  background: color-mix(in srgb, var(--ring) 15%, transparent);
}

.dashboard-range-button--active {
  background: linear-gradient(135deg, #7c3aed, #3b82f6);
  color: #fff;
  border-color: transparent;
}

.dashboard-multi-line-chart {
  width: 100%;
  height: 20rem;
  margin-top: 0.5rem;
}

/* ========== GOALS SECTION ========== */

.dashboard-goals-section {
  border: 1px solid color-mix(in srgb, var(--ring) 24%, transparent);
  border-radius: 1rem;
  background: color-mix(in srgb, var(--surface) 90%, transparent);
  padding: 1rem;
}

.dashboard-goals-section h2 {
  margin: 0 0 1rem;
  font-family: 'Sora', 'Space Grotesk', sans-serif;
  font-size: 1.1rem;
}

.dashboard-goal-item {
  margin-bottom: 1.25rem;
}

.dashboard-goal-item:last-child {
  margin-bottom: 0;
}

.dashboard-goal-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 0.4rem;
}

.dashboard-goal-label {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text);
}

.dashboard-goal-count {
  margin: 0.15rem 0 0;
  font-size: 0.75rem;
  color: var(--text-soft);
}

.dashboard-goal-percent {
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--text);
}

.dashboard-progress-bar {
  width: 100%;
  height: 0.65rem;
  background: color-mix(in srgb, var(--ring) 15%, transparent);
  border-radius: 9999px;
  overflow: hidden;
}

.dashboard-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #8b5cf6, #6366f1);
  border-radius: 9999px;
  transition: width 0.5s ease-out;
}

.dashboard-progress-fill--subs {
  background: linear-gradient(90deg, #10b981, #059669);
}

/* ========== ROW 3: STREAM HISTORY TABLE ========== */

.dashboard-history-section {
  border: 1px solid color-mix(in srgb, var(--ring) 24%, transparent);
  border-radius: 1rem;
  background: color-mix(in srgb, var(--surface) 90%, transparent);
  padding: 1rem;
}

.dashboard-history-section h2 {
  margin: 0 0 0.8rem;
  font-family: 'Sora', 'Space Grotesk', sans-serif;
  font-size: 1.1rem;
}

.dashboard-table-container {
  border-radius: 0.75rem;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--ring) 20%, transparent);
}

.dashboard-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.dashboard-table thead {
  background: color-mix(in srgb, var(--ring) 12%, transparent);
}

.dashboard-table th {
  padding: 0.65rem 0.8rem;
  text-align: left;
  font-weight: 700;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-soft);
  border-bottom: 1px solid color-mix(in srgb, var(--ring) 20%, transparent);
}

.dashboard-table td {
  padding: 0.65rem 0.8rem;
  border-bottom: 1px solid color-mix(in srgb, var(--ring) 10%, transparent);
  color: var(--text);
}

.dashboard-table tbody tr:last-child td {
  border-bottom: none;
}

.dashboard-table tbody tr:hover {
  background: color-mix(in srgb, var(--ring) 8%, transparent);
}

.dashboard-table-empty {
  text-align: center;
  padding: 2rem;
  color: var(--text-soft);
  font-style: italic;
}

/* ========== RESPONSIVE ========== */

@media (max-width: 1024px) {
  .dashboard-kpis {
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  }

  .dashboard-middle-row {
    grid-template-columns: 1fr;
  }

  .dashboard-multi-line-chart {
    height: 16rem;
  }
}

@media (max-width: 720px) {
  .auth-navbar {
    display: flex;
    flex-wrap: nowrap;
    padding: 0.8rem;
  }

  .auth-navbar__nav {
    display: none;
  }

  .auth-navbar__profile {
    display: none;
  }

  .auth-navbar__mobile {
    display: block;
    margin-left: auto;
  }

  .auth-layout__content {
    padding: 0.75rem;
  }

  .dashboard-header {
    flex-direction: column;
  }

  .dashboard-kpis {
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 0.6rem;
  }

  .dashboard-kpi-card {
    padding: 0.8rem;
  }

  .dashboard-kpi-card__value {
    font-size: 1.25rem;
  }

  .dashboard-table {
    font-size: 0.75rem;
  }

  .dashboard-table th,
  .dashboard-table td {
    padding: 0.5rem 0.6rem;
  }
}
```

---

## Summary of Changes

### Backend
1. ✅ `dashboard.route.ts` - Add follower/sub counts and goals to bootstrap response
2. ✅ No database changes needed (schemas already support the queries)

### Frontend
1. ✅ `dashboard.model.ts` - Update `DashboardBootstrapData` interface
2. ✅ `dashboard.component.ts` - Add new computed signals, multi-line chart builder, helper methods
3. ✅ `dashboard.component.html` - Complete template restructure with 3-row layout
4. ✅ `en.json` / `es.json` - Add translations for new KPIs, goals, history
5. ✅ `styles.css` - Update dashboard CSS for new layout

---

## Technical Notes

### Chart Configuration
- Uses existing `DashboardChartConfigService.getLineChartBase()` for consistent theming
- 5 colored lines with smooth curves, circular symbols
- Legend at top for toggling visibility
- Custom tooltip showing all metrics for hovered date
- Colors:
  - Bits: #f59e0b (amber)
  - Subs: #10b981 (emerald)
  - Hours: #3b82f6 (blue)
  - Viewers: #8b5cf6 (purple)
  - Follows: #ec4899 (pink)

### Goals Implementation
- Hardcoded 1,000 goals for followers and subs
- Progress calculated as `current / goal * 100`
- Visual progress bar with percentage label
- Different gradient colors for each goal type

### Stream History
- Shows last 30 streams from `streamHistory` (already filtered by time range)
- Sorted by date (backend returns in chronological order, need to reverse for recent→oldest)
- Displays: date, duration (formatted as "Xh Ym"), viewers, bits, donations, follows, subs
- Empty state when no streams exist

### Time Range Filtering
- Existing `filterByTimeRange()` method already works
- Applies to trend data and stream history
- Multi-line chart respects selected time range

---

## Testing Checklist

- [ ] Verify bootstrap endpoint returns `totalFollowers`, `totalSubs`, `totalFollows30d`, `monthlyGoals`
- [ ] Check all 5 KPI cards display correct values
- [ ] Verify multi-line chart shows all 5 metrics with correct colors
- [ ] Test time range selector (7d, 30d, 90d, all) updates chart data
- [ ] Confirm goals section displays correct counts and percentages
- [ ] Check stream history table shows streams in correct order (recent→oldest)
- [ ] Test responsive behavior on mobile/tablet
- [ ] Verify dark/light mode theming applies correctly
- [ ] Check translations for both EN and ES
- [ ] Ensure accessibility (ARIA labels, semantic HTML, keyboard navigation)
