import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  Activity,
  ArrowRight,
  AudioLines,
  Bot,
  Check,
  Command,
  Radio,
  ShieldCheck,
  Terminal,
  Users,
  Zap,
  LucideAngularModule,
} from 'lucide-angular';

import { LanguageService } from '../../../../../services/language.service';
import { LinksService } from '../../../../../services/links.service';

@Component({
  selector: 'app-sol-opencode-mock-2',
  imports: [RouterLink, LucideAngularModule],
  templateUrl: './sol-opencode-mock-2.component.html',
  styleUrl: './sol-opencode-mock-2.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SolOpencodeMock2Component {
  private readonly languageService = inject(LanguageService);
  private readonly linksService = inject(LinksService);

  readonly discordUrl = this.linksService.getDiscordUrl();
  readonly terminalIcon = Terminal;
  readonly radioIcon = Radio;
  readonly shieldIcon = ShieldCheck;
  readonly commandIcon = Command;
  readonly activityIcon = Activity;
  readonly audioIcon = AudioLines;
  readonly usersIcon = Users;
  readonly zapIcon = Zap;
  readonly botIcon = Bot;
  readonly arrowIcon = ArrowRight;
  readonly checkIcon = Check;

  t(key: string): string {
    return this.languageService.translate(key);
  }
}
