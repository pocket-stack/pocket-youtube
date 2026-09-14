// @title Pocket YouTube
// The baseline presentation: one screen, d-pad first, touch where the panel
// has it (PSP, Vita). pocket.json compiles this entry wherever no declared
// presentation matches the target's modality.
import SingleScreen from "./presentations/single-screen.tsx";
import { installYoutubeDriver } from "./driver.ts";
import { mount } from "@pocketjs/framework";

installYoutubeDriver();
mount(() => <SingleScreen />);
