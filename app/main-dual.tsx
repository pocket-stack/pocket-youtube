// @title Pocket YouTube
// The dual-screen presentation: video on the top screen, controls and
// browsing on a touch bottom screen (New 3DS). pocket.json compiles this
// entry for targets whose modality has two screens with contacts on the
// auxiliary one.
import DualScreen from "./presentations/dual-screen.tsx";
import { installYoutubeDriver } from "./driver.ts";
import { mount } from "@pocketjs/framework";

installYoutubeDriver();
mount(() => <DualScreen />);
