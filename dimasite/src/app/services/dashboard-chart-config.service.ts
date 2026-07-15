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
    // Live First chart palette
    const axisColor = isDark ? '#9aa3b5' : '#667085';
    const gridColor = isDark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(15, 17, 21, 0.08)';
    const tooltipBg = isDark ? '#171a21' : '#ffffff';
    const tooltipBorder = isDark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(15, 17, 21, 0.08)';
    const tooltipText = isDark ? '#f5f7fb' : '#14151a';

    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        backgroundColor: tooltipBg,
        borderColor: tooltipBorder,
        borderWidth: 1,
        textStyle: {
          color: tooltipText
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
    const axisColor = isDark ? '#9aa3b5' : '#667085';
    const gridColor = isDark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(15, 17, 21, 0.08)';
    const tooltipBg = isDark ? '#171a21' : '#ffffff';
    const tooltipBorder = isDark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(15, 17, 21, 0.08)';

    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: tooltipBg,
        borderColor: tooltipBorder,
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
