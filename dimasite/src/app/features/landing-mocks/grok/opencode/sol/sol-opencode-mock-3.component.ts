import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  Activity,
  ArrowRight,
  AudioLines,
  Check,
  Heart,
  MessageCircle,
  Play,
  Radio,
  ShieldCheck,
  Sparkles,
  Users,
  Zap,
  LucideAngularModule,
} from 'lucide-angular';

import { LanguageService } from '../../../../../services/language.service';
import { LinksService } from '../../../../../services/links.service';

@Component({
  selector: 'app-sol-opencode-mock-3',
  imports: [RouterLink, LucideAngularModule],
  templateUrl: './sol-opencode-mock-3.component.html',
  styleUrl: './sol-opencode-mock-3.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SolOpencodeMock3Component {
  private readonly languageService = inject(LanguageService);
  private readonly linksService = inject(LinksService);

  readonly discordUrl = this.linksService.getDiscordUrl();
  readonly radioIcon = Radio;
  readonly playIcon = Play;
  readonly usersIcon = Users;
  readonly messageIcon = MessageCircle;
  readonly heartIcon = Heart;
  readonly shieldIcon = ShieldCheck;
  readonly zapIcon = Zap;
  readonly activityIcon = Activity;
  readonly audioIcon = AudioLines;
  readonly sparkleIcon = Sparkles;
  readonly checkIcon = Check;
  readonly arrowIcon = ArrowRight;

  t(key: string): string {
    return this.languageService.translate(key);
  }
}
