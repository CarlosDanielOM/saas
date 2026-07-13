import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  Activity,
  ArrowRight,
  AudioLines,
  Check,
  MessageCircle,
  ShieldCheck,
  Sparkles,
  Zap,
  LucideAngularModule,
} from 'lucide-angular';

import { LanguageService } from '../../../../../services/language.service';
import { LinksService } from '../../../../../services/links.service';

@Component({
  selector: 'app-sol-opencode-mock-1',
  imports: [RouterLink, LucideAngularModule],
  templateUrl: './sol-opencode-mock-1.component.html',
  styleUrl: './sol-opencode-mock-1.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SolOpencodeMock1Component {
  private readonly languageService = inject(LanguageService);
  private readonly linksService = inject(LinksService);

  readonly discordUrl = this.linksService.getDiscordUrl();
  readonly messageIcon = MessageCircle;
  readonly shieldIcon = ShieldCheck;
  readonly zapIcon = Zap;
  readonly activityIcon = Activity;
  readonly audioIcon = AudioLines;
  readonly sparkleIcon = Sparkles;
  readonly arrowIcon = ArrowRight;
  readonly checkIcon = Check;

  t(key: string): string {
    return this.languageService.translate(key);
  }
}
