import {
  isFullscreenActive,
  isMouseClicksDisabled,
  isMouseTrackingEnabled,
} from '../../utils/fullscreen.js'
import { mouseAvailability, type MouseAvailability } from './logView.js'

/**
 * 读一次环境,得到「鼠标点击此刻能不能用」。
 *
 * 单独一个文件,是为了让 `mouseAvailability` 那个**纯**组合函数留在 logView 里被单测钉住 ——
 * 三个开关的组合正是最容易写错的地方,而 env 一旦进了纯函数就再也测不动了。
 * 同时这里也是**唯一**的 env 读取点:树面板和详情页共用它,页脚上的话只有一个出处。
 */
export function currentMouseAvailability(): MouseAvailability {
  return mouseAvailability({
    fullscreen: isFullscreenActive(),
    tracking: isMouseTrackingEnabled(),
    clicks: !isMouseClicksDisabled(),
  })
}
