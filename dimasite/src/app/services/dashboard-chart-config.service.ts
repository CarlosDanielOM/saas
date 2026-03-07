import { Injectable, inject } from '@angular/core';
import { EChartsOption } from 'echarts';

import { ThemeService } from './theme.service';

@Injectable({
  providedIn: 'root'
})
export class DashboardChartConfigService {
  private readonly themeService = inject(ThemeService);

  getLineChartBase(): EChartsOption {
    const isDark = this.themeService.isDarkMode();
    const axisColor = isDark ? '#c7b8df' : '#523679';
    const gridColor = isDark ? 'rgba(199, 184, 223, 0.15)' : 'rgba(82, 54, 121, 0.14)';

    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        backgroundColor: isDark ? '#1a1227' : '#fffdfc',
        borderColor: isDark ? '#45305f' : '#e7d8ff',
        borderWidth: 1,
        textStyle: {
          color: isDark ? '#f5f1ff' : '#2a163f'
        }
      },
      grid: {
        left: 44,
        right: 24,
        top: 28,
        bottom: 40
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        axisLine: { lineStyle: { color: gridColor } },
        axisTick: { show: false },
        axisLabel: { color: axisColor }
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false },
        axisLabel: { color: axisColor },
        splitLine: { lineStyle: { color: gridColor, type: 'dashed' } }
      }
    };
  }

  getBarChartBase(): EChartsOption {
    const isDark = this.themeService.isDarkMode();
    const axisColor = isDark ? '#c7b8df' : '#523679';
    const gridColor = isDark ? 'rgba(199, 184, 223, 0.15)' : 'rgba(82, 54, 121, 0.14)';

    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: isDark ? '#1a1227' : '#fffdfc',
        borderColor: isDark ? '#45305f' : '#e7d8ff',
        borderWidth: 1
      },
      grid: {
        left: 44,
        right: 20,
        top: 24,
        bottom: 38
      },
      xAxis: {
        type: 'category',
        axisLine: { lineStyle: { color: gridColor } },
        axisTick: { show: false },
        axisLabel: { color: axisColor }
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false },
        axisLabel: { color: axisColor },
        splitLine: { lineStyle: { color: gridColor, type: 'dashed' } }
      }
    };
  }
}
